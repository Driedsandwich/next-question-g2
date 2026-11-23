import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('config', () => {
  it('defaults: port 8788, replay, rules, no voice', () => {
    const c = loadConfig({})
    expect(c).toMatchObject({ port: 8788, questionSource: 'replay', merger: 'rules', stt: 'none', replaySpeed: 1, replaySessionMin: 30, telegramChatId: '', telegramPresenterId: '' })
  })
  it('reads the settings and refuses unknown values', () => {
    expect(loadConfig({ QUESTION_SOURCE: 'telegram', MERGER: 'openai-compatible', STT: 'openai-compatible', PORT: '9000' })).toMatchObject({ port: 9000, questionSource: 'telegram' })
    expect(() => loadConfig({ QUESTION_SOURCE: 'slack' })).toThrow(/QUESTION_SOURCE/)
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/)
    expect(() => loadConfig({ REPLAY_SPEED: '0' })).toThrow(/REPLAY_SPEED/)
  })
})
