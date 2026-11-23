/** Text helpers: cleaning a question and a small word-overlap similarity (no network, no model). */

export const MAX_QUESTION_CHARS = 200
export const MIN_QUESTION_CHARS = 3
export const MAX_TAKEAWAY_CHARS = 140

// Control characters, zero-width characters and line separators (built from code points so the source stays plain ASCII).
const CONTROL_CHARS = new RegExp('[' + ['\\u0000-\\u001f', '\\u007f-\\u009f', '\\u200b-\\u200f', '\\u2028\\u2029', '\\ufeff'].join('') + ']', 'g')

/** One line, no control characters, trimmed, capped. Returns '' if too short to be a question. */
export function cleanQuestion(raw: string): string {
  const t = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (t.length < MIN_QUESTION_CHARS) return ''
  return t.length > MAX_QUESTION_CHARS ? t.slice(0, MAX_QUESTION_CHARS - 3).trimEnd() + '...' : t
}

export function cleanTakeaway(raw: string): string {
  const t = cleanQuestion(raw)
  return t.length > MAX_TAKEAWAY_CHARS ? t.slice(0, MAX_TAKEAWAY_CHARS - 3).trimEnd() + '...' : t
}

const STOP = new Set(
  (
    'a an the is are was were be been being am do does did will would can could should shall may might must have has had to of in on at for with ' +
    'and or but if so as it its this that these those i you we they he she me my your our their us what whats which who whom whose why how about ' +
    'any there here also just really please tell going get gets got plan planned planning team project guys guy again soon ever more much many ' +
    'some into from by up out than then them when'
  ).split(/\s+/),
)
// "when" is meaningful (asking about time), so it is not a stop word: it is mapped to the 'when' token below.
STOP.delete('when')

// Words that mean the same thing for this kind of question. Applied before stemming.
const CANON: Record<string, string> = {
  date: 'when',
  timeline: 'when',
  eta: 'when',
  schedule: 'when',
  timing: 'when',
  release: 'launch',
  released: 'launch',
  releases: 'launch',
  releasing: 'launch',
  live: 'launch',
  golive: 'launch',
  rollout: 'launch',
  ship: 'launch',
  shipping: 'launch',
  shipped: 'launch',
}

function stem(w: string): string {
  let s = w
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y'
  else if (s.length > 4 && s.endsWith('ing')) s = s.slice(0, -3)
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2)
  else if (s.length > 4 && s.endsWith('es')) s = s.slice(0, -2)
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1)
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1)
  return s
}

/** Content words of a question: lower-case, no punctuation, no filler words, light stemming. */
export function contentTokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const out = new Set<string>()
  for (const w of words) {
    const c = CANON[w] ?? w
    if (STOP.has(c)) continue
    out.add(stem(c))
  }
  return [...out]
}

export interface Similarity {
  shared: number
  jaccard: number
  similar: boolean
}

/**
 * Two questions are "the same" when they share at least 2 content words and at least 60% of all their words,
 * or share a word and almost all of them (covers one-word questions). The numbers were chosen with the paraphrase pairs
 * and the look-alike pairs in test/merger.test.ts (at 50% the mainnet/testnet pair was folded together, so it is 60%).
 * Known limit: two different questions that share almost all their words ("When is mainnet?" / "When is mainnet audited?") can still be folded.
 */
export function similarity(a: string, b: string): Similarity {
  const A = new Set(contentTokens(a))
  const B = new Set(contentTokens(b))
  let shared = 0
  for (const t of A) if (B.has(t)) shared += 1
  const union = A.size + B.size - shared
  const jaccard = union === 0 ? 0 : shared / union
  const similar = (shared >= 2 && jaccard >= 0.6) || (shared >= 1 && jaccard >= 0.8)
  return { shared, jaccard, similar }
}
