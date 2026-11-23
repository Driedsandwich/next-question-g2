import fs from 'node:fs'
import path from 'node:path'
import { Engine } from '../src/engine.ts'
import { rulesMerger } from '../src/merger.ts'
import type { Announcer, AnsweredLog, AnsweredRow, Clock, Merger, Transcriber } from '../src/types.ts'

export function tmpDir(): string {
  const base = path.join(process.cwd(), '.tmp')
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, 'test-'))
}

export function rmTmp(dir: string): void {
  if (!dir.includes(`${path.sep}.tmp${path.sep}test-`)) throw new Error('refusing to delete outside .tmp/test-*')
  fs.rmSync(dir, { recursive: true, force: true })
}

export class FakeClock implements Clock {
  constructor(public t: number) {}
  now(): number {
    return this.t
  }
  advance(ms: number): void {
    this.t += ms
  }
}

export class MemLog implements AnsweredLog {
  rows: AnsweredRow[] = []
  async append(row: AnsweredRow): Promise<void> {
    this.rows.push(row)
  }
}

export class RecAnnouncer implements Announcer {
  lines: string[] = []
  async announce(text: string): Promise<void> {
    this.lines.push(text)
  }
}

export interface Rig {
  engine: Engine
  clock: FakeClock
  log: MemLog
  say: RecAnnouncer
}

export const T0 = new Date(2026, 10, 24, 12, 0, 0).getTime()

export function rig(opts: { merger?: Merger; transcriber?: Transcriber; live?: boolean; minutes?: number } = {}): Rig {
  const clock = new FakeClock(T0)
  const log = new MemLog()
  const say = new RecAnnouncer()
  const engine = new Engine({ source: 'replay', merger: opts.merger ?? rulesMerger, transcriber: opts.transcriber ?? null, log, announcer: say, clock })
  return { engine, clock, log, say }
}

/** A rig whose AMA is already live (the start announcement is cleared). */
export async function liveRig(opts: { merger?: Merger; transcriber?: Transcriber; minutes?: number } = {}): Promise<Rig> {
  const r = rig(opts)
  await r.engine.startSession(opts.minutes ?? 30)
  r.say.lines.length = 0
  return r
}
