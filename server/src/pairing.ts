import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const MAX_PAIR_FAILS = 5
export const PAIR_LOCK_MS = 10 * 60 * 1000
const MAX_PAIR_CLIENTS = 1000

export function rememberPairAttempt<T>(attempts: Map<string, T>, key: string, value: T): void {
  if (!attempts.has(key) && attempts.size === MAX_PAIR_CLIENTS) {
    attempts.delete(attempts.keys().next().value!)
  }
  attempts.set(key, value)
}

export function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

/** Load the saved pairing code from `<dir>/pair.json`, or create and save a new one. */
export function loadOrCreatePairCode(dir: string): string {
  const file = path.join(dir, 'pair.json')
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { code?: string }
    if (typeof j.code === 'string' && /^\d{6}$/.test(j.code)) return j.code
  } catch {
    // fall through and create
  }
  const code = generateCode()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ code, createdAt: new Date().toISOString() }), { mode: 0o600 })
  return code
}

/** Accepts `Authorization: Pair 123456`. Constant-time compare. */
export function checkPairHeader(header: string | undefined, code: string): boolean {
  const candidate = pairHeaderCode(header)
  return candidate !== undefined && checkPairCode(candidate, code)
}

export function pairHeaderCode(header: string | undefined): string | undefined {
  return /^Pair\s+(\d{6})$/.exec(header?.trim() ?? '')?.[1]
}

/** Checks a bare 6-digit code (used for `/pair <code>` in a private Telegram chat). Constant-time compare. */
export function checkPairCode(candidate: string, code: string): boolean {
  const m = /^\d{6}$/.exec(candidate.trim())
  if (!m) return false
  const a = Buffer.from(m[0])
  const b = Buffer.from(code)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
