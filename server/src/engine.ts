import { contentTokens, cleanQuestion, cleanTakeaway, similarity } from './text.ts'
import type { Announcer, AnsweredLog, Clock, Merger, Question, SourceName, Transcriber } from './types.ts'
import { systemClock } from './types.ts'

/** How long the "Answered" screen shows. The answer is announced and recorded only after this window, so a swipe up can take it back. */
export const ANSWER_WINDOW_MS = 4000
export const DEFAULT_SESSION_MIN = 30
const MAX_OPEN = 300
const MAX_HISTORY = 20
const MAX_PROPOSALS = 20

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class VoiceUnavailableError extends Error {
  constructor() {
    super('voice is not available: STT=none on the server')
  }
}

export type SessionStatus = 'waiting' | 'live' | 'ended'
export type Mode = 'waiting' | 'empty' | 'question' | 'answered' | 'ended'

export interface PublicState {
  version: number
  now: number
  source: string
  mode: Mode
  session: { status: SessionStatus; minutes: number | null; minutesLeft: number | null; startedAt: number | null; endsAt: number | null }
  head: null | { id: string; text: string; votes: number }
  /** "3 of 17": position = answered so far + 1, total = answered + still open. */
  position: number
  total: number
  counts: { open: number; answered: number; collected: number }
  answered: null | { id: string; text: string; takeaway: string | null; msLeft: number; expiresAt: number }
  ended: null | { answered: number; left: number }
}

export interface QuestionRow {
  id: string
  text: string
  votes: number
  skipped: boolean
}

interface PendingAnswer {
  q: Question
  takeaway: string | null
  expiresAt: number
  entry: HistoryEntry
}

type HistoryEntry = { kind: 'skip'; qid: string; prevSkipSeq: number } | { kind: 'answer'; qid: string }

export interface Proposal {
  id: string
  fromId: string
  intoId: string
  reason: string
  status: 'applied' | 'pending'
  jaccard: number
}

export interface AskResult {
  id: string
  merged: boolean
  votes: number
  text: string
}
export interface VoteResult {
  id: string | null
  votes: number
  added: boolean
  status: 'open' | 'answered' | 'unknown'
}

export interface EngineDeps {
  source: SourceName
  merger: Merger
  transcriber: Transcriber
  log: AnsweredLog
  announcer: Announcer
  clock?: Clock
  answerWindowMs?: number
}

/** Open questions in the order the presenter sees them: never-skipped first, then by votes (most first), then oldest first. */
export function orderQuestions(qs: Question[]): Question[] {
  return [...qs].sort((a, b) => a.skipSeq - b.skipSeq || b.voters.size - a.voters.size || a.seq - b.seq)
}

export class Engine {
  private open: Question[] = []
  private pending: PendingAnswer | null = null
  private history: HistoryEntry[] = []
  private aliases = new Map<string, string>() // merged-away id -> surviving id
  private answeredRecent: { id: string; text: string; votes: number; takeaway: string | null }[] = []
  private committedCount = 0
  private collected = 0
  private proposals: Proposal[] = []
  private seq = 0
  private skipCounter = 0
  private idCounter = 0
  private proposalCounter = 0
  private session: { status: SessionStatus; minutes: number | null; startedAt: number | null; endsAt: number | null } = {
    status: 'waiting',
    minutes: null,
    startedAt: null,
    endsAt: null,
  }
  private lastEmittedMinutes: number | null = null
  private version = 0
  private listeners = new Set<(s: PublicState) => void>()
  private clock: Clock
  private windowMs: number
  private lock: Promise<unknown> = Promise.resolve()

  constructor(private deps: EngineDeps) {
    this.clock = deps.clock ?? systemClock
    this.windowMs = deps.answerWindowMs ?? ANSWER_WINDOW_MS
  }

  subscribe(fn: (s: PublicState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    this.version += 1
    const s = this.getState()
    this.lastEmittedMinutes = s.session.minutesLeft
    for (const l of this.listeners) l(s)
  }

  /** Run steps that await (the merger, the log) one at a time so two requests cannot interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => undefined)
    return run
  }

  private minutesLeft(now: number): number | null {
    if (this.session.status !== 'live' || this.session.endsAt === null) return null
    return Math.max(0, Math.ceil((this.session.endsAt - now) / 60000))
  }

  private ordered(): Question[] {
    return orderQuestions(this.open)
  }

  private resolve(id: string): string {
    let cur = id
    for (let i = 0; i < 10 && this.aliases.has(cur); i++) cur = this.aliases.get(cur)!
    return cur
  }

  getState(): PublicState {
    const now = this.clock.now()
    const ordered = this.ordered()
    const head = ordered[0] ?? null
    const answeredCount = this.committedCount + (this.pending ? 1 : 0)
    const status = this.session.status
    let mode: Mode
    if (status === 'ended') mode = 'ended'
    else if (status === 'waiting') mode = 'waiting'
    else if (this.pending && now < this.pending.expiresAt) mode = 'answered'
    else mode = head ? 'question' : 'empty'
    return {
      version: this.version,
      now,
      source: this.deps.source,
      mode,
      session: {
        status,
        minutes: this.session.minutes,
        minutesLeft: this.minutesLeft(now),
        startedAt: this.session.startedAt,
        endsAt: this.session.endsAt,
      },
      head: head ? { id: head.id, text: head.text, votes: head.voters.size } : null,
      position: answeredCount + 1,
      total: answeredCount + this.open.length,
      counts: { open: this.open.length, answered: answeredCount, collected: this.collected },
      answered: this.pending
        ? {
            id: this.pending.q.id,
            text: this.pending.q.text,
            takeaway: this.pending.takeaway,
            msLeft: Math.max(0, this.pending.expiresAt - now),
            expiresAt: this.pending.expiresAt,
          }
        : null,
      ended: status === 'ended' ? { answered: answeredCount, left: this.open.length } : null,
    }
  }

  /** The queue for the AI and the phone screen: no voter keys. */
  questions(limit = 20): QuestionRow[] {
    return this.ordered()
      .slice(0, limit)
      .map((q) => ({ id: q.id, text: q.text, votes: q.voters.size, skipped: q.skipSeq > 0 }))
  }

  // ---------- audience side ----------

  /** A new question. The asker counts as the first vote. A repeat of an open question adds a vote to it instead. */
  ask(rawText: string, voterKey: string): Promise<AskResult> {
    return this.serial(async () => {
      if (this.session.status === 'ended') throw new ConflictError('the AMA has ended')
      const text = cleanQuestion(rawText)
      if (!text) throw new ConflictError('question is too short')
      const matchId = await this.deps.merger(
        text,
        this.open.map((q) => ({ id: q.id, text: q.text })),
      )
      const target = matchId ? this.open.find((q) => q.id === matchId) : undefined
      if (target) {
        target.voters.add(voterKey)
        target.mergedCount += 1
        this.emit()
        return { id: target.id, merged: true, votes: target.voters.size, text: target.text }
      }
      if (this.open.length >= MAX_OPEN) throw new ConflictError('too many open questions')
      this.idCounter += 1
      this.seq += 1
      const q: Question = { id: `q${this.idCounter}`, text, voters: new Set([voterKey]), seq: this.seq, skipSeq: 0, mergedCount: 0 }
      this.open.push(q)
      this.collected += 1
      this.emit()
      return { id: q.id, merged: false, votes: 1, text }
    })
  }

  /** One vote per person per question. A vote for a question that was merged away goes to the one it was merged into. */
  vote(qid: string, voterKey: string): VoteResult {
    const id = this.resolve(qid)
    const q = this.open.find((x) => x.id === id)
    if (!q) {
      const done = (this.pending && this.pending.q.id === id) || this.answeredRecent.some((a) => a.id === id)
      return { id: done ? id : null, votes: 0, added: false, status: done ? 'answered' : 'unknown' }
    }
    if (q.voters.has(voterKey)) return { id: q.id, votes: q.voters.size, added: false, status: 'open' }
    q.voters.add(voterKey)
    this.emit()
    return { id: q.id, votes: q.voters.size, added: true, status: 'open' }
  }

  // ---------- presenter side ----------

  private requireLive(): void {
    if (this.session.status !== 'live') throw new ConflictError('no live AMA')
  }

  private requireHead(id?: string): Question {
    const head = this.ordered()[0]
    if (!head) throw new NotFoundError('no open question')
    if (id !== undefined && id !== head.id) throw new ConflictError('the screen is out of date: the next question changed')
    return head
  }

  /** Mark the next question answered. It is announced and written to the log when the undo window closes. */
  answer(input: { id?: string; takeaway?: string } = {}): Promise<PublicState> {
    return this.serial(async () => {
      this.requireLive()
      this.requireHead(input.id)
      await this.commitPending() // an earlier answer still inside its window is final now
      this.requireLive()
      const head = this.requireHead(input.id) // look again: nothing else may have moved while the log was written
      const cleaned = input.takeaway ? cleanTakeaway(input.takeaway) : ''
      this.open = this.open.filter((q) => q.id !== head.id)
      const entry: HistoryEntry = { kind: 'answer', qid: head.id }
      this.history.push(entry)
      if (this.history.length > MAX_HISTORY) this.history.shift()
      this.pending = { q: head, takeaway: cleaned || null, expiresAt: this.clock.now() + this.windowMs, entry }
      this.emit()
      return this.getState()
    })
  }

  /** Move the next question to the back of the line. */
  skip(input: { id?: string } = {}): PublicState {
    this.requireLive()
    const head = this.requireHead(input.id)
    if (this.open.length < 2) throw new ConflictError('there is no other question to show')
    const prev = head.skipSeq
    this.skipCounter += 1
    head.skipSeq = this.skipCounter
    this.history.push({ kind: 'skip', qid: head.id, prevSkipSeq: prev })
    if (this.history.length > MAX_HISTORY) this.history.shift()
    this.emit()
    return this.getState()
  }

  /** Undo the last skip, or the last answer while its window is open. An answer whose window closed cannot be taken back. */
  back(): PublicState {
    this.requireLive()
    const top = this.history[this.history.length - 1]
    if (!top) throw new ConflictError('nothing to go back to')
    if (top.kind === 'skip') {
      this.history.pop()
      const q = this.open.find((x) => x.id === top.qid)
      if (q) q.skipSeq = top.prevSkipSeq
      this.emit()
      return this.getState()
    }
    if (this.pending && this.pending.entry === top && this.clock.now() < this.pending.expiresAt) {
      this.history.pop()
      this.open.push(this.pending.q)
      this.pending = null
      this.emit()
      return this.getState()
    }
    throw new ConflictError('too late to take that answer back')
  }

  async voice(pcm: Uint8Array, id?: string): Promise<{ text: string; state: PublicState }> {
    if (!this.deps.transcriber) throw new VoiceUnavailableError()
    this.requireLive()
    this.requireHead(id)
    const text = await this.deps.transcriber(pcm)
    const takeaway = cleanTakeaway(text)
    if (!takeaway) throw new ConflictError('no speech recognized')
    const state = await this.answer({ id, takeaway })
    return { text: takeaway, state }
  }

  private async commitPending(): Promise<void> {
    const p = this.pending
    if (!p) return
    this.pending = null
    this.committedCount += 1
    const i = this.history.indexOf(p.entry)
    if (i >= 0) this.history = this.history.slice(i + 1) // older steps can no longer be undone past an announced answer
    const votes = p.q.voters.size
    this.answeredRecent.push({ id: p.q.id, text: p.q.text, votes, takeaway: p.takeaway })
    if (this.answeredRecent.length > 500) this.answeredRecent.shift()
    try {
      await this.deps.log.append({ at: new Date(this.clock.now()).toISOString(), id: p.q.id, question: p.q.text, votes, takeaway: p.takeaway, source: this.deps.source })
    } catch (e) {
      console.error(`[log] append failed: ${(e as Error).message}`)
    }
    const line = p.takeaway ? `✅ ${p.q.text} — ${p.takeaway}` : `✅ Answered: ${p.q.text}`
    await this.say(line)
  }

  private async say(text: string): Promise<void> {
    try {
      await this.deps.announcer.announce(text)
    } catch (e) {
      console.error(`[announce] failed: ${(e as Error).message}`)
    }
  }

  // ---------- session ----------

  /** Start the AMA. From "waiting" the questions collected so far are kept; from "ended" everything is cleared. */
  startSession(minutes?: number): Promise<PublicState> {
    return this.serial(async () => {
      if (this.session.status === 'live') throw new ConflictError('the AMA is already live')
      const min = clampMinutes(minutes ?? DEFAULT_SESSION_MIN)
      if (this.session.status === 'ended') this.resetAll()
      const now = this.clock.now()
      this.session = { status: 'live', minutes: min, startedAt: now, endsAt: now + min * 60000 }
      this.emit()
      await this.say(`🎤 The AMA is open for ${min} min. Ask with /ask <your question>, then tap ▲ on the ones you want answered.`)
      return this.getState()
    })
  }

  /** Change the remaining minutes of a live AMA. */
  setMinutesLeft(minutes: number): PublicState {
    this.requireLive()
    const min = clampMinutes(minutes)
    this.session.endsAt = this.clock.now() + min * 60000
    this.emit()
    return this.getState()
  }

  endSession(): Promise<PublicState> {
    return this.serial(async () => {
      if (this.session.status !== 'live') throw new ConflictError('no live AMA to end')
      await this.commitPending()
      this.session.status = 'ended'
      this.emit()
      const answered = this.committedCount
      await this.say(`🏁 The AMA has ended. Answered: ${answered}. Not reached: ${this.open.length}.`)
      return this.getState()
    })
  }

  private resetAll(): void {
    this.open = []
    this.pending = null
    this.history = []
    this.aliases.clear()
    this.answeredRecent = []
    this.committedCount = 0
    this.collected = 0
    this.proposals = []
    this.skipCounter = 0
  }

  // ---------- merging ----------

  /** Fold `fromId` into `intoId` (votes are added, the old id keeps working). Used by the proposal path. */
  private mergeNow(fromId: string, intoId: string): void {
    const from = this.open.find((q) => q.id === fromId)!
    const into = this.open.find((q) => q.id === intoId)!
    for (const v of from.voters) into.voters.add(v)
    into.mergedCount += 1 + from.mergedCount
    this.aliases.set(from.id, into.id)
    this.open = this.open.filter((q) => q.id !== from.id)
    this.history = this.history.filter((h) => h.qid !== from.id)
    this.emit()
  }

  /**
   * An AI agent suggests that two open questions are the same. The queue changes only if the server's own rule agrees.
   * Otherwise the proposal stays "pending" and nothing about the queue changes (there is no glasses gesture to confirm it).
   */
  proposeMerge(fromId: string, intoId: string, reason = ''): Proposal {
    const f = this.open.find((q) => q.id === this.resolve(fromId))
    const t = this.open.find((q) => q.id === this.resolve(intoId))
    if (!f || !t) throw new NotFoundError('both questions must be open')
    if (f.id === t.id) throw new ConflictError('those are already the same question')
    const sim = similarity(f.text, t.text)
    this.proposalCounter += 1
    const p: Proposal = {
      id: `p${this.proposalCounter}`,
      fromId: f.id,
      intoId: t.id,
      reason: reason.replace(/\s+/g, ' ').trim().slice(0, 120),
      status: sim.similar ? 'applied' : 'pending',
      jaccard: Math.round(sim.jaccard * 100) / 100,
    }
    this.proposals.push(p)
    if (this.proposals.length > MAX_PROPOSALS) this.proposals.shift()
    if (sim.similar) this.mergeNow(f.id, t.id)
    return p
  }

  // ---------- summary and upkeep ----------

  getSummary(): { answered: number; remaining: number; collected: number; topTopics: { word: string; score: number }[]; pendingProposals: number } {
    const score = new Map<string, number>()
    const add = (text: string, votes: number) => {
      for (const t of contentTokens(text)) score.set(t, (score.get(t) ?? 0) + votes)
    }
    for (const q of this.open) add(q.text, q.voters.size)
    for (const a of this.answeredRecent) add(a.text, a.votes)
    if (this.pending) add(this.pending.q.text, this.pending.q.voters.size)
    const topTopics = [...score.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([word, s]) => ({ word, score: s }))
    return {
      answered: this.committedCount + (this.pending ? 1 : 0),
      remaining: this.open.length,
      collected: this.collected,
      topTopics,
      pendingProposals: this.proposals.filter((p) => p.status === 'pending').length,
    }
  }

  /** Call regularly (and in tests with a fake clock). Announces answers whose window has closed; ticks the minutes. */
  async tick(): Promise<void> {
    const now = this.clock.now()
    if (this.pending && now >= this.pending.expiresAt) {
      await this.serial(async () => {
        if (this.pending && this.clock.now() >= this.pending.expiresAt) {
          await this.commitPending()
          this.emit()
        }
      })
    } else if (this.session.status === 'live' && this.minutesLeft(now) !== this.lastEmittedMinutes) {
      this.emit()
    }
  }

  async close(): Promise<void> {
    await this.serial(async () => {
      await this.commitPending()
    })
  }
}

function clampMinutes(m: number): number {
  if (!Number.isFinite(m)) throw new ConflictError('minutes must be a number')
  return Math.min(240, Math.max(1, Math.round(m)))
}
