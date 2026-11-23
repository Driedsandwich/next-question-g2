export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
export type Transcriber = ((pcm: Uint8Array) => Promise<string>) | null

export interface Clock {
  now(): number
}
export const systemClock: Clock = { now: () => Date.now() }

export type SourceName = 'replay' | 'telegram'

/**
 * One open question. `voters` holds opaque keys (for example a hash-free Telegram user id) only to stop double votes.
 * It lives in memory, is never sent to the glasses, never written to disk and never shown in any API answer.
 */
export interface Question {
  id: string
  text: string
  voters: Set<string>
  seq: number // creation order (earlier = smaller)
  skipSeq: number // 0 = never skipped; larger = skipped later
  mergedCount: number // how many other questions were folded into this one
}

/** A row of data/answered.jsonl. No names, no user ids. */
export interface AnsweredRow {
  at: string // ISO time
  id: string
  question: string
  votes: number
  takeaway: string | null
  source: SourceName
}

export interface AnsweredLog {
  append(row: AnsweredRow): Promise<void>
}

/** Posts a line to the group (Telegram) or to the console (replay). */
export interface Announcer {
  announce(text: string): Promise<void>
}

/** Decides whether a new question repeats an open one. Returns that question's id, or null. */
export type Merger = (text: string, open: { id: string; text: string }[]) => Promise<string | null>
