import fs from 'node:fs'
import path from 'node:path'
import type { AnsweredLog, AnsweredRow } from './types.ts'

/** Append-only JSON Lines file: data/answered.jsonl. One row per answered question, no names. */
export class JsonlAnsweredLog implements AnsweredLog {
  private file: string
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'answered.jsonl')
  }
  async append(row: AnsweredRow): Promise<void> {
    await fs.promises.appendFile(this.file, JSON.stringify(row) + '\n', { mode: 0o600 })
  }
}

export function readAnsweredFile(file: string): AnsweredRow[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as AnsweredRow]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
