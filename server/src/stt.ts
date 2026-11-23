import type { FetchLike, Transcriber } from './types.ts'

/** Wrap raw PCM (16 kHz, 16-bit little-endian, mono) in a WAV container. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 16000, channels = 1, bits = 16): Uint8Array {
  const header = Buffer.alloc(44)
  const byteRate = (sampleRate * channels * bits) / 8
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE((channels * bits) / 8, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export interface SttOptions {
  baseUrl: string
  apiKey: string
  model: string
  fetchImpl?: FetchLike
}

export function openAICompatibleTranscriber(opts: SttOptions): Transcriber {
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  return async (pcm) => {
    const form = new FormData()
    form.append('model', opts.model)
    form.append('file', new Blob([Buffer.from(pcmToWav(pcm))], { type: 'audio/wav' }), 'voice.wav')
    const res = await doFetch(`${opts.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}` },
      body: form,
    })
    if (!res.ok) throw new Error(`STT HTTP ${res.status}`)
    const json = (await res.json()) as { text?: string }
    return (json.text ?? '').trim()
  }
}
