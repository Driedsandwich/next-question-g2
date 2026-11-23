import { describe, expect, it } from 'vitest'
import { openAICompatibleTranscriber, pcmToWav } from '../src/stt.ts'

describe('pcmToWav', () => {
  it('writes a 44-byte header for 16 kHz 16-bit mono', () => {
    const pcm = new Uint8Array(3200)
    const wav = Buffer.from(pcmToWav(pcm))
    expect(wav.length).toBe(44 + 3200)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(28)).toBe(32000) // byte rate
    expect(wav.readUInt32LE(40)).toBe(3200)
  })
})

describe('openAICompatibleTranscriber', () => {
  it('posts multipart to /audio/transcriptions and returns trimmed text', async () => {
    let seen = ''
    let auth: string | null = null
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen = url
      auth = new Headers(init?.headers).get('authorization')
      expect(init?.body).toBeInstanceOf(FormData)
      return new Response(JSON.stringify({ text: ' hello ' }), { status: 200 })
    }
    const t = openAICompatibleTranscriber({ baseUrl: 'https://stt.invalid/v1/', apiKey: 'test-key', model: 'm', fetchImpl })!
    expect(await t(new Uint8Array(100))).toBe('hello')
    expect(seen).toBe('https://stt.invalid/v1/audio/transcriptions')
    expect(auth).toBe('Bearer test-key')
  })
})
