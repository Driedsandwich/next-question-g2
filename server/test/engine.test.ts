import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { JsonlAnsweredLog } from '../src/answered.ts'
import { ANSWER_WINDOW_MS, ConflictError, Engine, NotFoundError, VoiceUnavailableError, orderQuestions } from '../src/engine.ts'
import { rulesMerger } from '../src/merger.ts'
import { FakeClock, RecAnnouncer, T0, liveRig, rmTmp, rig, tmpDir } from './helpers.ts'

const dir = tmpDir()
afterAll(() => rmTmp(dir))

async function fill(r: Awaited<ReturnType<typeof liveRig>>) {
  const a = await r.engine.ask('Who funds the foundation?', 'u1')
  const b = await r.engine.ask('How do you keep bridge transfers safe?', 'u2')
  const c = await r.engine.ask('Will the docs be translated?', 'u3')
  return { a, b, c }
}

describe('order', () => {
  it('most votes first, then the earlier question', async () => {
    const r = await liveRig()
    const { a, b, c } = await fill(r)
    expect(r.engine.getState().head?.id).toBe(a.id) // all 1 vote: earliest first
    r.engine.vote(c.id, 'x1')
    r.engine.vote(c.id, 'x2')
    r.engine.vote(b.id, 'x1')
    expect(r.engine.questions().map((q) => q.id)).toEqual([c.id, b.id, a.id])
  })
  it('orderQuestions puts a skipped question after every unskipped one', () => {
    const mk = (id: string, votes: number, seq: number, skipSeq: number) => ({ id, text: id, voters: new Set(Array.from({ length: votes }, (_, i) => `v${i}`)), seq, skipSeq, mergedCount: 0 })
    expect(orderQuestions([mk('a', 9, 1, 1), mk('b', 1, 2, 0), mk('c', 1, 3, 0)]).map((q) => q.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('asking and merging', () => {
  it('counts the asker as the first vote and folds a repeat into the open question', async () => {
    const r = await liveRig()
    const q = await r.engine.ask('When is the mainnet launch?', 'u1')
    expect(q).toMatchObject({ merged: false, votes: 1 })
    const again = await r.engine.ask('What is the planned date for mainnet release?', 'u2')
    expect(again).toMatchObject({ id: q.id, merged: true, votes: 2 })
    expect(r.engine.getState().counts).toMatchObject({ open: 1, collected: 1 })
  })
  it('one vote per person; a vote for an unknown question is reported, not counted', async () => {
    const r = await liveRig()
    const q = await r.engine.ask('Who funds the foundation?', 'u1')
    expect(r.engine.vote(q.id, 'u1').added).toBe(false)
    expect(r.engine.vote(q.id, 'u2')).toMatchObject({ added: true, votes: 2 })
    expect(r.engine.vote(q.id, 'u2').added).toBe(false)
    expect(r.engine.vote('q404', 'u2')).toMatchObject({ added: false, status: 'unknown' })
  })
  it('rejects too-short text and any question after the AMA has ended', async () => {
    const r = await liveRig()
    await expect(r.engine.ask('hi', 'u1')).rejects.toBeInstanceOf(ConflictError)
    await r.engine.endSession()
    await expect(r.engine.ask('Who funds the foundation?', 'u1')).rejects.toBeInstanceOf(ConflictError)
  })
  it('waiting: questions are collected before the AMA starts', async () => {
    const r = rig()
    await r.engine.ask('Who funds the foundation?', 'u1')
    const s = r.engine.getState()
    expect(s.mode).toBe('waiting')
    expect(s.counts.collected).toBe(1)
    await r.engine.startSession(10)
    expect(r.engine.getState().mode).toBe('question')
  })
})

describe('skip and back', () => {
  it('skip sends the head to the back of the line; back puts it at the front again', async () => {
    const r = await liveRig()
    const { a, b, c } = await fill(r)
    r.engine.skip({ id: a.id })
    expect(r.engine.questions().map((q) => q.id)).toEqual([b.id, c.id, a.id])
    expect(r.engine.questions()[2]!.skipped).toBe(true)
    r.engine.back()
    expect(r.engine.questions().map((q) => q.id)).toEqual([a.id, b.id, c.id])
    expect(r.engine.questions()[0]!.skipped).toBe(false)
  })
  it('keeps the position while skipping, and a skipped question with many votes stays behind unskipped ones', async () => {
    const r = await liveRig()
    const { a, b, c } = await fill(r)
    for (let i = 0; i < 5; i++) r.engine.vote(a.id, `x${i}`)
    r.engine.skip()
    expect(r.engine.getState()).toMatchObject({ position: 1, total: 3 })
    expect(r.engine.getState().head?.id).toBe(b.id)
    r.engine.skip()
    r.engine.skip()
    expect(r.engine.questions().map((q) => q.id)).toEqual([a.id, b.id, c.id]) // everything skipped: the oldest skip comes first
  })
  it('refuses to skip when it is the only question, and to go back with no history', async () => {
    const r = await liveRig()
    expect(() => r.engine.back()).toThrow(ConflictError)
    await r.engine.ask('Who funds the foundation?', 'u1')
    expect(() => r.engine.skip()).toThrow(ConflictError)
  })
  it('a stale id (the screen moved on) is refused', async () => {
    const r = await liveRig()
    const { a, b } = await fill(r)
    expect(() => r.engine.skip({ id: b.id })).toThrow(ConflictError)
    await expect(r.engine.answer({ id: b.id })).rejects.toBeInstanceOf(ConflictError)
    expect(r.engine.getState().head?.id).toBe(a.id)
  })
})

describe('answering', () => {
  it('shows "answered" for the window, then announces and records once', async () => {
    const r = await liveRig()
    const { a, b } = await fill(r)
    const s = await r.engine.answer({ id: a.id })
    expect(s.mode).toBe('answered')
    expect(s.head?.id).toBe(b.id)
    expect(s.counts.answered).toBe(1)
    expect(r.say.lines).toEqual([]) // nothing announced yet
    expect(r.log.rows).toEqual([])
    r.clock.advance(ANSWER_WINDOW_MS - 1)
    await r.engine.tick()
    expect(r.say.lines).toEqual([])
    r.clock.advance(2)
    await r.engine.tick()
    expect(r.say.lines).toEqual(['✅ Answered: Who funds the foundation?'])
    expect(r.log.rows).toHaveLength(1)
    expect(r.log.rows[0]).toMatchObject({ id: a.id, question: 'Who funds the foundation?', votes: 1, takeaway: null, source: 'replay' })
    await r.engine.tick()
    expect(r.log.rows).toHaveLength(1) // not twice
    expect(r.engine.getState().mode).toBe('question')
  })
  it('back inside the window takes the answer back and nothing is announced', async () => {
    const r = await liveRig()
    const { a } = await fill(r)
    await r.engine.answer({ id: a.id })
    r.engine.back()
    r.clock.advance(ANSWER_WINDOW_MS + 1000)
    await r.engine.tick()
    expect(r.say.lines).toEqual([])
    expect(r.log.rows).toEqual([])
    expect(r.engine.getState()).toMatchObject({ head: { id: a.id }, counts: { answered: 0, open: 3 } })
  })
  it('back after the window is refused: it was already announced', async () => {
    const r = await liveRig()
    const { a } = await fill(r)
    await r.engine.answer({ id: a.id })
    r.clock.advance(ANSWER_WINDOW_MS + 1)
    await r.engine.tick()
    expect(() => r.engine.back()).toThrow(/nothing to go back to|too late/)
    expect(r.say.lines).toHaveLength(1)
  })
  it('a second answer inside the window makes the first final at once', async () => {
    const r = await liveRig()
    const { a, b } = await fill(r)
    await r.engine.answer({ id: a.id })
    await r.engine.answer({ id: b.id })
    expect(r.say.lines).toEqual(['✅ Answered: Who funds the foundation?'])
    await r.engine.close()
    expect(r.say.lines).toHaveLength(2)
    expect(r.log.rows.map((x) => x.id)).toEqual([a.id, b.id])
  })
  it('there is nothing to answer when the queue is empty or the AMA is not live', async () => {
    const r = await liveRig()
    await expect(r.engine.answer()).rejects.toBeInstanceOf(NotFoundError)
    const w = rig()
    await w.engine.ask('Who funds the foundation?', 'u1')
    await expect(w.engine.answer()).rejects.toBeInstanceOf(ConflictError)
  })
  it('writes the answered log to data/answered.jsonl with no names or ids', async () => {
    const clock = new FakeClock(T0)
    const say = new RecAnnouncer()
    const engine = new Engine({ source: 'telegram', merger: rulesMerger, transcriber: null, log: new JsonlAnsweredLog(path.join(dir, 'log')), announcer: say, clock })
    await engine.startSession(5)
    await engine.ask('Who funds the foundation?', '987654321')
    await engine.answer()
    await engine.close()
    const raw = fs.readFileSync(path.join(dir, 'log', 'answered.jsonl'), 'utf8')
    const row = JSON.parse(raw.trim()) as Record<string, unknown>
    expect(Object.keys(row).sort()).toEqual(['at', 'id', 'question', 'source', 'takeaway', 'votes'])
    expect(raw).not.toContain('987654321')
    expect(JSON.stringify(engine.getState())).not.toContain('987654321')
    expect(JSON.stringify(engine.questions())).not.toContain('987654321')
  })
})

describe('voice', () => {
  it('is 501-style (VoiceUnavailableError) when STT is off, and nothing changes', async () => {
    const r = await liveRig()
    const { a } = await fill(r)
    await expect(r.engine.voice(new Uint8Array(4000), a.id)).rejects.toBeInstanceOf(VoiceUnavailableError)
    expect(r.engine.getState().counts.answered).toBe(0)
  })
  it('turns speech into the takeaway and announces "question - takeaway"', async () => {
    const r = await liveRig({ transcriber: async () => ' Mainnet ships in Q2 after the audit ' })
    const { a } = await fill(r)
    const out = await r.engine.voice(new Uint8Array(4000), a.id)
    expect(out.text).toBe('Mainnet ships in Q2 after the audit')
    await r.engine.close()
    expect(r.say.lines).toEqual(['✅ Who funds the foundation? — Mainnet ships in Q2 after the audit'])
    expect(r.log.rows[0]!.takeaway).toBe('Mainnet ships in Q2 after the audit')
  })
  it('no recognised speech leaves the question open', async () => {
    const r = await liveRig({ transcriber: async () => '   ' })
    const { a } = await fill(r)
    await expect(r.engine.voice(new Uint8Array(4000), a.id)).rejects.toBeInstanceOf(ConflictError)
    expect(r.engine.getState().head?.id).toBe(a.id)
  })
})

describe('session', () => {
  it('start, minutes left, set minutes, end with a summary line', async () => {
    const r = rig()
    await r.engine.startSession(20)
    expect(r.say.lines[0]).toContain('20 min')
    expect(r.engine.getState().session.minutesLeft).toBe(20)
    r.clock.advance(2 * 60000 + 1)
    expect(r.engine.getState().session.minutesLeft).toBe(18)
    r.engine.setMinutesLeft(5)
    expect(r.engine.getState().session.minutesLeft).toBe(5)
    await r.engine.ask('Who funds the foundation?', 'u1')
    await r.engine.ask('How do you keep bridge transfers safe?', 'u2')
    await r.engine.answer()
    const s = await r.engine.endSession()
    expect(s.mode).toBe('ended')
    expect(s.ended).toEqual({ answered: 1, left: 1 })
    expect(r.say.lines.at(-1)).toContain('Answered: 1. Not reached: 1.')
    expect(r.say.lines).toContain('✅ Answered: Who funds the foundation?') // the pending answer was announced before the end
  })
  it('tick sends a new state when the minute changes', async () => {
    const r = await liveRig({ minutes: 10 })
    const seen: number[] = []
    r.engine.subscribe((s) => seen.push(s.session.minutesLeft ?? -1))
    await r.engine.tick()
    expect(seen).toEqual([])
    r.clock.advance(60001)
    await r.engine.tick()
    expect(seen).toEqual([9])
  })
  it('a second AMA after "ended" starts clean', async () => {
    const r = await liveRig()
    await r.engine.ask('Who funds the foundation?', 'u1')
    await r.engine.endSession()
    await r.engine.startSession(10)
    expect(r.engine.getState()).toMatchObject({ mode: 'empty', counts: { open: 0, answered: 0, collected: 0 } })
  })
  it('starting twice and ending with no AMA are refused', async () => {
    const r = await liveRig()
    await expect(r.engine.startSession()).rejects.toBeInstanceOf(ConflictError)
    const w = rig()
    await expect(w.engine.endSession()).rejects.toBeInstanceOf(ConflictError)
  })
})

describe('merge proposals from an AI agent', () => {
  it('a proposal the server rule does not accept is pending and the queue does not change', async () => {
    const r = await liveRig()
    const { a, b, c } = await fill(r)
    const before = JSON.stringify(r.engine.questions())
    const p = r.engine.proposeMerge(b.id, a.id, 'both about money')
    expect(p.status).toBe('pending')
    expect(JSON.stringify(r.engine.questions())).toBe(before)
    expect(r.engine.getSummary().pendingProposals).toBe(1)
    expect(c.id).toBeTruthy()
  })
  it('a proposal the server rule accepts is applied: votes are added and the old id still works', async () => {
    const r = await liveRig({ merger: async () => null }) // a merger that never merges, so both stay open
    const x = await r.engine.ask('When is the mainnet launch?', 'u1')
    const y = await r.engine.ask('What is the planned date for mainnet release?', 'u2')
    expect(r.engine.getState().counts.open).toBe(2)
    const p = r.engine.proposeMerge(y.id, x.id)
    expect(p.status).toBe('applied')
    expect(r.engine.getState().counts.open).toBe(1)
    expect(r.engine.questions()[0]).toMatchObject({ id: x.id, votes: 2 })
    expect(r.engine.vote(y.id, 'u3')).toMatchObject({ id: x.id, added: true, votes: 3 }) // vote for the merged-away id lands on the survivor
  })
  it('rejects unknown ids and merging a question with itself', async () => {
    const r = await liveRig()
    const { a } = await fill(r)
    expect(() => r.engine.proposeMerge(a.id, 'q404')).toThrow(NotFoundError)
    expect(() => r.engine.proposeMerge(a.id, a.id)).toThrow(ConflictError)
  })
})

describe('summary', () => {
  it('counts answered and remaining and lists the top words by votes', async () => {
    const r = await liveRig()
    const { a } = await fill(r)
    r.engine.vote(a.id, 'x1')
    await r.engine.answer({ id: a.id })
    const s = r.engine.getSummary()
    expect(s).toMatchObject({ answered: 1, remaining: 2, collected: 3 })
    expect(s.topTopics.length).toBeGreaterThan(0)
    expect(s.topTopics.length).toBeLessThanOrEqual(5)
  })
})
