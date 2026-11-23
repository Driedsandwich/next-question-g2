import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/http.ts'
import { liveRig, type Rig } from './helpers.ts'

let server: http.Server
let base = ''
let r: Rig
const auth = { authorization: 'Pair 424242' }
const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: auth, body: body === undefined ? undefined : JSON.stringify(body) })
const get = (path: string) => fetch(`${base}${path}`, { headers: auth })

beforeAll(async () => {
  r = await liveRig({ minutes: 30 })
  server = createApp({ engine: r.engine, pairCode: '424242' })
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
})

describe('HTTP interface (loopback only)', () => {
  it('health is open; everything else needs the pair header', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
    expect((await fetch(`${base}/api/state`)).status).toBe(401)
    expect((await fetch(`${base}/api/state`, { headers: { authorization: 'Pair 000000' } })).status).toBe(401)
    expect((await get('/api/state')).status).toBe(200)
  })
  it('answers the CORS preflight without auth and allows the Authorization header', async () => {
    const res = await fetch(`${base}/api/answer`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization')
  })
  it('question flow: state -> skip -> back -> answer (with a stale id refused) -> back inside the window', async () => {
    await r.engine.ask('Who funds the foundation?', 'u1')
    const b = await r.engine.ask('How do you keep bridge transfers safe?', 'u2')
    await r.engine.ask('Will the docs be translated?', 'u3')
    r.engine.vote(b.id, 'x')
    const s = (await (await get('/api/state')).json()) as { mode: string; head: { id: string }; position: number; total: number }
    expect(s).toMatchObject({ mode: 'question', position: 1, total: 3, head: { id: b.id } })
    const stale = await post('/api/answer', { id: 'q1' })
    expect(stale.status).toBe(409)
    expect(((await (await post('/api/skip', { id: b.id })).json()) as { head: { id: string } }).head.id).not.toBe(b.id)
    expect(((await (await post('/api/back')).json()) as { head: { id: string } }).head.id).toBe(b.id)
    const a = (await (await post('/api/answer', { id: b.id })).json()) as { mode: string; counts: { answered: number } }
    expect(a).toMatchObject({ mode: 'answered', counts: { answered: 1 } })
    const back = (await (await post('/api/back')).json()) as { mode: string; counts: { answered: number } }
    expect(back).toMatchObject({ mode: 'question', counts: { answered: 0 } })
  })
  it('lists the queue and the summary without any voter data', async () => {
    const q = (await (await get('/api/questions?limit=2')).json()) as { questions: Record<string, unknown>[] }
    expect(q.questions).toHaveLength(2)
    expect(Object.keys(q.questions[0]!).sort()).toEqual(['id', 'skipped', 'text', 'votes'])
    const s = (await (await get('/api/summary')).json()) as Record<string, unknown>
    expect(Object.keys(s).sort()).toEqual(['answered', 'collected', 'pendingProposals', 'remaining', 'topTopics'])
  })
  it('voice is 501 with STT=none, and too-short audio is 400', async () => {
    expect((await fetch(`${base}/api/voice`, { method: 'POST', headers: auth, body: new Uint8Array(4000) })).status).toBe(501)
    expect((await fetch(`${base}/api/voice`, { method: 'POST', headers: auth, body: new Uint8Array(10) })).status).toBe(400)
  })
  it('propose-merge: a rule-rejected proposal is pending and leaves the queue alone', async () => {
    const qs = (await (await get('/api/questions')).json()) as { questions: { id: string }[] }
    const before = JSON.stringify(qs)
    const res = await post('/api/propose-merge', { fromId: qs.questions[0]!.id, intoId: qs.questions[1]!.id, reason: 'test' })
    expect(((await res.json()) as { status: string }).status).toBe('pending')
    expect(JSON.stringify(await (await get('/api/questions')).json())).toBe(before)
    expect((await post('/api/propose-merge', { fromId: 'q1' })).status).toBe(400)
  })
  it('session: set minutes, end, then actions are refused; start again', async () => {
    expect(((await (await post('/api/session', { action: 'set_minutes', minutes: 7 })).json()) as { session: { minutesLeft: number } }).session.minutesLeft).toBe(7)
    expect(((await (await post('/api/session', { action: 'end' })).json()) as { mode: string }).mode).toBe('ended')
    expect((await post('/api/skip', {})).status).toBe(409)
    expect((await post('/api/session', { action: 'nope' })).status).toBe(400)
    expect(((await (await post('/api/session', { action: 'start', minutes: 12 })).json()) as { session: { minutes: number } }).session.minutes).toBe(12)
  })
  it('SSE sends the current state first', async () => {
    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/events`, { headers: auth, signal: ctrl.signal })
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    ctrl.abort()
    expect(first).toContain('event: state')
    expect(first).toContain('"mode":"empty"') // after the restart in the previous test the queue is empty
  })
})
