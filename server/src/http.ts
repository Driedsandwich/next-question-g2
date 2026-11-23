import http from 'node:http'
import type { Engine, PublicState } from './engine.ts'
import { ConflictError, NotFoundError, VoiceUnavailableError } from './engine.ts'
import { checkPairHeader } from './pairing.ts'

const MAX_JSON = 64 * 1024
const MAX_PCM = 2_000_000 // about 62 s of 16 kHz 16-bit mono

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

function cors(res: http.ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'Authorization, Content-Type')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-max-age', '600')
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const b = c as Buffer
    size += b.length
    if (size > max) throw new HttpError(413, 'body too large')
    chunks.push(b)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req, MAX_JSON)
  if (buf.length === 0) return {}
  try {
    const v = JSON.parse(buf.toString('utf8'))
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid JSON body')
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export interface AppDeps {
  engine: Engine
  pairCode: string
}

export function createApp({ engine, pairCode }: AppDeps): http.Server {
  return http.createServer(async (req, res) => {
    cors(res)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = `${req.method} ${url.pathname}`
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      if (route === 'GET /api/health') return send(res, 200, { ok: true, app: 'next-question' })
      if (!checkPairHeader(req.headers.authorization, pairCode)) {
        return send(res, 401, { error: 'pairing required: send "Authorization: Pair <6-digit code>"' })
      }
      switch (route) {
        case 'GET /api/state':
          return send(res, 200, engine.getState())
        case 'GET /api/events': {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
          const write = (s: PublicState) => res.write(`event: state\ndata: ${JSON.stringify(s)}\n\n`)
          write(engine.getState())
          const off = engine.subscribe(write)
          const hb = setInterval(() => res.write(': ping\n\n'), 15000)
          req.on('close', () => {
            off()
            clearInterval(hb)
          })
          return
        }
        case 'GET /api/questions': {
          const n = Number(url.searchParams.get('limit') ?? 20)
          return send(res, 200, { questions: engine.questions(Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 20) })
        }
        case 'GET /api/summary':
          return send(res, 200, engine.getSummary())
        case 'POST /api/answer': {
          const b = await readJson(req)
          return send(res, 200, await engine.answer({ id: str(b.id) }))
        }
        case 'POST /api/skip': {
          const b = await readJson(req)
          return send(res, 200, engine.skip({ id: str(b.id) }))
        }
        case 'POST /api/back':
          return send(res, 200, engine.back())
        case 'POST /api/voice': {
          const pcm = await readBody(req, MAX_PCM)
          if (pcm.length < 3200) throw new HttpError(400, 'audio too short')
          const out = await engine.voice(new Uint8Array(pcm), url.searchParams.get('id') ?? undefined)
          return send(res, 200, { text: out.text, state: out.state })
        }
        case 'POST /api/session': {
          const b = await readJson(req)
          const minutes = typeof b.minutes === 'number' ? b.minutes : undefined
          if (b.action === 'start') return send(res, 200, await engine.startSession(minutes))
          if (b.action === 'end') return send(res, 200, await engine.endSession())
          if (b.action === 'set_minutes') {
            if (minutes === undefined) throw new HttpError(400, 'minutes is required')
            return send(res, 200, engine.setMinutesLeft(minutes))
          }
          throw new HttpError(400, 'action must be start, end or set_minutes')
        }
        case 'POST /api/propose-merge': {
          const b = await readJson(req)
          const from = str(b.fromId)
          const into = str(b.intoId)
          if (!from || !into) throw new HttpError(400, 'fromId and intoId are required')
          return send(res, 200, engine.proposeMerge(from, into, str(b.reason)))
        }
        default:
          return send(res, 404, { error: 'not found' })
      }
    } catch (e) {
      if (res.headersSent) return res.end()
      if (e instanceof HttpError) return send(res, e.status, { error: e.message })
      if (e instanceof NotFoundError) return send(res, 404, { error: e.message })
      if (e instanceof ConflictError) return send(res, 409, { error: e.message })
      if (e instanceof VoiceUnavailableError) return send(res, 501, { error: e.message })
      console.error(`[http] ${route}: ${(e as Error).message}`)
      return send(res, 500, { error: 'internal error' })
    }
  })
}
