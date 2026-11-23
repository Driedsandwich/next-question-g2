import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openAICompatibleMerger, parseMatch, rulesMerger } from '../src/merger.ts'
import { ReplaySource, loadFixture } from '../src/sources/replay.ts'
import { cleanQuestion, contentTokens, similarity } from '../src/text.ts'
import { liveRig } from './helpers.ts'

describe('cleanQuestion', () => {
  it('makes one line, trims, and rejects very short text', () => {
    expect(cleanQuestion('  When\n is   mainnet?\t ')).toBe('When is mainnet?')
    expect(cleanQuestion('hi')).toBe('')
    expect(cleanQuestion('a'.repeat(500)).length).toBeLessThanOrEqual(200)
  })
})

describe('similarity rule', () => {
  it('ignores case and punctuation', () => {
    expect(contentTokens('When is Mainnet?!')).toEqual(contentTokens('when is mainnet'))
  })
  const same: [string, string][] = [
    ['When is the mainnet launch?', 'What is the planned date for mainnet release?'],
    ['How will token holders vote on governance proposals?', 'How does governance voting work for token holders?'],
    ['Will there be an airdrop for early supporters?', 'Is an airdrop planned for early community supporters?'],
    ['when is mainnet', 'WHEN IS MAINNET???'],
  ]
  it.each(same)('merges the paraphrase pair: %s / %s', (a, b) => {
    expect(similarity(a, b).similar).toBe(true)
  })
  const different: [string, string][] = [
    ['When is the mainnet launch?', 'Is the mainnet contract audited, and by whom?'],
    ['When is mainnet?', 'Is mainnet audited?'],
    ['How are token holders rewarded?', 'How will token holders vote on governance proposals?'],
    ['When is the mainnet launch?', 'When is the testnet launch?'],
    ['Will there be an airdrop?', 'Will there be a token burn?'],
  ]
  it.each(different)('keeps look-alike questions apart: %s / %s', (a, b) => {
    expect(similarity(a, b).similar).toBe(false)
  })
})

describe('rulesMerger', () => {
  it('returns the id of the closest open question, or null', async () => {
    const open = [
      { id: 'q1', text: 'When is the mainnet launch?' },
      { id: 'q2', text: 'Is the mainnet contract audited?' },
    ]
    expect(await rulesMerger('What is the planned date for mainnet release?', open)).toBe('q1')
    expect(await rulesMerger('Who funds the foundation?', open)).toBeNull()
    expect(await rulesMerger('anything at all', [])).toBeNull()
  })
})

describe('openAICompatibleMerger', () => {
  const open = [{ id: 'q1', text: 'When is the mainnet launch?' }]
  const reply = (content: string) => async (_url?: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

  it('uses a valid model answer', async () => {
    let url = ''
    const m = openAICompatibleMerger({
      baseUrl: 'https://llm.invalid/v1/',
      apiKey: 'test-key',
      model: 'm',
      fetchImpl: async (u, i) => {
        url = u
        return reply('{"match":"q1"}')(u, i)
      },
    })
    expect(await m('totally different words here', open)).toBe('q1')
    expect(url).toBe('https://llm.invalid/v1/chat/completions')
  })
  it('accepts "no match" from the model even when the rules would match', async () => {
    const m = openAICompatibleMerger({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', fetchImpl: reply('{"match":null}') })
    expect(await m('When is the mainnet launch date?', open)).toBeNull()
  })
  it('falls back to the rules on an unknown id, bad JSON or an HTTP error', async () => {
    const text = 'What is the planned date for mainnet release?'
    for (const f of [reply('{"match":"q99"}'), reply('no idea'), async () => new Response('x', { status: 500 })]) {
      const m = openAICompatibleMerger({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', fetchImpl: f })
      expect(await m(text, open)).toBe('q1')
    }
  })
  it('parseMatch accepts only known ids', () => {
    expect(parseMatch('{"match":"q1"}', new Set(['q1']))).toBe('q1')
    expect(parseMatch('{"match":"q2"}', new Set(['q1']))).toBeUndefined()
    expect(parseMatch('{"match":null}', new Set(['q1']))).toBeNull()
  })
})

describe('replay fixture', () => {
  it('has 20 distinct questions and exactly 3 paraphrases that fold into earlier ones', async () => {
    const fx = loadFixture(path.join(process.cwd(), 'fixtures', 'questions.json'))
    const asks = fx.events.filter((e) => e.ask)
    expect(asks.length).toBe(23)
    const { engine } = await liveRig()
    const src = new ReplaySource({ fixture: fx, speed: 1, sessionMin: 30 })
    let merged = 0
    for (const ev of fx.events) {
      const before = engine.getState().counts.collected
      await src.fire(engine, ev)
      if (ev.ask && engine.getState().counts.collected === before) merged += 1
    }
    expect(merged).toBe(3)
    expect(engine.getState().counts.open).toBe(20)
    src.stop()
  })
})
