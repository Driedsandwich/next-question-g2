import path from 'node:path'

export interface Config {
  port: number
  questionSource: 'replay' | 'telegram'
  merger: 'rules' | 'openai-compatible'
  stt: 'none' | 'openai-compatible'
  dataDir: string
  replaySpeed: number
  replaySessionMin: number
  telegramChatId: string
  telegramPresenterId: string
}

function oneOf<T extends string>(name: string, v: string | undefined, allowed: readonly T[], def: T): T {
  if (v === undefined || v === '') return def
  if ((allowed as readonly string[]).includes(v)) return v as T
  throw new Error(`${name}=${v} is not one of: ${allowed.join(', ')}`)
}

function num(name: string, v: string | undefined, def: number): number {
  if (v === undefined || v === '') return def
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name}=${v} is not a number`)
  return n
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const speed = num('REPLAY_SPEED', env.REPLAY_SPEED, 1)
  if (speed <= 0) throw new Error('REPLAY_SPEED must be greater than 0')
  return {
    port: num('PORT', env.PORT, 8788),
    questionSource: oneOf('QUESTION_SOURCE', env.QUESTION_SOURCE, ['replay', 'telegram'] as const, 'replay'),
    merger: oneOf('MERGER', env.MERGER, ['rules', 'openai-compatible'] as const, 'rules'),
    stt: oneOf('STT', env.STT, ['none', 'openai-compatible'] as const, 'none'),
    dataDir: path.resolve(env.DATA_DIR || path.join(process.cwd(), 'data')),
    replaySpeed: speed,
    replaySessionMin: num('REPLAY_SESSION_MIN', env.REPLAY_SESSION_MIN, 30),
    telegramChatId: (env.TELEGRAM_CHAT_ID ?? '').trim(),
    telegramPresenterId: (env.TELEGRAM_PRESENTER_ID ?? '').trim(),
  }
}
