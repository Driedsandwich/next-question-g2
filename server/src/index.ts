import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonlAnsweredLog } from './answered.ts'
import { loadConfig } from './config.ts'
import { Engine } from './engine.ts'
import { createApp } from './http.ts'
import { openAICompatibleMerger, rulesMerger } from './merger.ts'
import { loadOrCreatePairCode } from './pairing.ts'
import type { QuestionSource } from './sources.ts'
import { ReplaySource, loadFixture } from './sources/replay.ts'
import { TelegramSource } from './sources/telegram.ts'
import { openAICompatibleTranscriber } from './stt.ts'
import type { Merger, Transcriber } from './types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Minimal .env reader (KEY=VALUE lines) so no extra dependency is needed. Real env vars win. */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    if (process.env[m[1]!] === undefined && m[2] !== '') process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
  }
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required for this setting (see env.example)`)
  return v
}

async function main(): Promise<void> {
  loadDotEnv(path.resolve(here, '../../.env'))
  loadDotEnv(path.resolve(here, '../.env'))
  const cfg = loadConfig()
  const pairCode = loadOrCreatePairCode(cfg.dataDir)

  let source: QuestionSource
  if (cfg.questionSource === 'telegram') {
    source = new TelegramSource({ token: required('TELEGRAM_BOT_TOKEN'), pairCode, chatId: cfg.telegramChatId, presenterId: cfg.telegramPresenterId })
  } else {
    source = new ReplaySource({ fixture: loadFixture(path.resolve(here, '../fixtures/questions.json')), speed: cfg.replaySpeed, sessionMin: cfg.replaySessionMin })
  }

  const merger: Merger =
    cfg.merger === 'openai-compatible'
      ? openAICompatibleMerger({ baseUrl: required('LLM_BASE_URL'), apiKey: required('LLM_API_KEY'), model: required('LLM_MODEL') })
      : rulesMerger

  const transcriber: Transcriber =
    cfg.stt === 'openai-compatible'
      ? openAICompatibleTranscriber({ baseUrl: required('STT_BASE_URL'), apiKey: required('STT_API_KEY'), model: process.env.STT_MODEL || 'whisper-1' })
      : null

  const engine = new Engine({ source: source.name, merger, transcriber, log: new JsonlAnsweredLog(cfg.dataDir), announcer: source.announcer })
  const server = createApp({ engine, pairCode })

  await new Promise<void>((resolve) => server.listen(cfg.port, '0.0.0.0', resolve))
  console.log('Next Question server')
  console.log(`  listening : http://0.0.0.0:${cfg.port}`)
  console.log(`  pair code : ${pairCode}   (glasses app sends "Authorization: Pair ${pairCode}")`)
  console.log(`  source=${cfg.questionSource} merger=${cfg.merger} stt=${cfg.stt}`)

  await source.start(engine)

  const timer = setInterval(() => {
    engine.tick().catch((e) => console.error(`[tick] ${(e as Error).message}`))
  }, 250)

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    clearInterval(timer)
    source.stop()
    await engine.close()
    server.close()
    server.closeAllConnections()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`)
  process.exit(1)
})
