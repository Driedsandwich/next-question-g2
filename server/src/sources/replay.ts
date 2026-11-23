import fs from 'node:fs'
import type { Sink, QuestionSource } from '../sources.ts'
import type { Announcer } from '../types.ts'

export interface ReplayEvent {
  /** Seconds after start (before the speed factor). */
  t: number
  /** Fixture name of a new question. */
  id?: string
  ask?: string
  /** Extra people who vote for the question named in `vote` (or for `id` when asked in the same event). */
  vote?: string
  n?: number
}

export interface ReplayFixture {
  events: ReplayEvent[]
}

export function loadFixture(file: string): ReplayFixture {
  const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReplayFixture>
  return { events: [...(j.events ?? [])].sort((a, b) => a.t - b.t) }
}

/** Prints what the Telegram bot would post. Never touches the network. */
export const consoleAnnouncer: Announcer = {
  async announce(text) {
    console.log(`[group] ${text}`)
  },
}

export interface ReplayOptions {
  fixture: ReplayFixture
  speed: number
  sessionMin: number
}

/** Feeds fictional questions and votes with the current time. Never touches the network. */
export class ReplaySource implements QuestionSource {
  readonly name = 'replay' as const
  readonly announcer = consoleAnnouncer
  private timers = new Set<NodeJS.Timeout>()
  private byFixtureId = new Map<string, string>()
  private stopped = false

  constructor(private opts: ReplayOptions) {}

  async start(sink: Sink): Promise<void> {
    await sink.startSession(this.opts.sessionMin)
    for (const ev of this.opts.fixture.events) {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        void this.fire(sink, ev)
      }, (ev.t * 1000) / this.opts.speed)
      this.timers.add(timer)
    }
  }

  /** Runs one event immediately. Exposed so tests can drive the replay without timers. */
  async fire(sink: Sink, ev: ReplayEvent): Promise<void> {
    if (this.stopped) return
    try {
      let target = ev.vote ? this.byFixtureId.get(ev.vote) : undefined
      if (ev.ask && ev.id) {
        const r = await sink.ask(ev.ask, `replay:${ev.id}:asker`)
        this.byFixtureId.set(ev.id, r.id)
        target = r.id
      }
      if (target && ev.n) {
        for (let k = 0; k < ev.n; k++) sink.vote(target, `replay:${ev.vote ?? ev.id}:${ev.t}:${k}`)
      }
    } catch (e) {
      console.error(`[replay] ${(e as Error).message}`)
    }
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }
}
