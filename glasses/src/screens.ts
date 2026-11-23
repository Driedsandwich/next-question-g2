import { CreateStartUpPageContainer, RebuildPageContainer, TextContainerProperty } from '@evenrealities/even_hub_sdk'
import type { ServerState } from './api.ts'
import { CHECK, DOT, ELLIPSIS, UP } from './glyphs.ts'

export type ScreenKind = 'setup' | 'offline' | 'waiting' | 'empty' | 'question' | 'answered' | 'ended'

export interface Ctx {
  configured: boolean
  online: boolean
  flash: string // short message for the hint line ("" = none)
}

export interface Screen {
  kind: ScreenKind
  /** Same layout id = same container set, so text can be updated in place without a rebuild. */
  layout: string
  text: TextContainerProperty[]
}

export const W = 576
export const H = 288
export const HINT = `Tap = answered ${DOT} Swipe = skip ${DOT} Hold = say answer`
export const BODY_COLS = 40
export const BODY_LINES = 3
const TITLE = `NEXT QUESTION ${DOT} AMA`

/**
 * Text from the audience becomes plain glass text: one line, no control characters, and the few typographic
 * characters that the G2 font may not have are replaced by ASCII. Everything else is left as it is.
 */
export function glassText(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, ELLIPSIS)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f]/g, ' ') // \s below also covers U+2028, U+2029 and U+FEFF
    .replace(/\s+/g, ' ')
    .trim()
}

/** Break text into at most `maxLines` lines of about `cols` characters; add "..." when text is cut. Never returns more lines than asked. */
export function wrapClip(raw: string, cols = BODY_COLS, maxLines = BODY_LINES): string {
  const text = glassText(raw)
  const lines: string[] = []
  let cur = ''
  let cut = false
  const push = (l: string): boolean => {
    if (lines.length >= maxLines) {
      cut = true
      return false
    }
    lines.push(l)
    return true
  }
  outer: for (let word of text.split(' ')) {
    while (word.length > cols) {
      // a very long word is split
      if (cur) {
        if (!push(cur)) break outer
        cur = ''
      }
      if (!push(word.slice(0, cols))) break outer
      word = word.slice(cols)
    }
    if (!word) continue
    if (!cur) cur = word
    else if (cur.length + 1 + word.length <= cols) cur += ' ' + word
    else {
      if (!push(cur)) break outer
      cur = word
    }
  }
  if (cur && !cut && !push(cur)) cut = true
  if (cut) {
    const last = lines.length - 1
    let l = lines[last] ?? ''
    if (l.length + ELLIPSIS.length > cols) l = l.slice(0, cols - ELLIPSIS.length).trimEnd()
    lines[last] = l + ELLIPSIS
  }
  return lines.join('\n')
}

export function oneLine(raw: string, cols = BODY_COLS): string {
  return wrapClip(raw, cols, 1)
}

export function timeLeft(s: ServerState): string {
  const m = s.session.minutesLeft
  if (m === null) return ''
  return m <= 0 ? 'time is up' : `${m} min left`
}

export function headerLine(s: ServerState): string {
  const votes = s.head ? s.head.votes : 0
  const parts = [`Next (${votes}${UP})`, `${s.position} of ${s.total}`]
  const t = timeLeft(s)
  if (t) parts.push(t)
  return parts.join(` ${DOT} `)
}

function container(id: number, name: string, x: number, y: number, w: number, h: number, content: string, capture: boolean, border = 0): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: x,
    yPosition: y,
    width: w,
    height: h,
    borderWidth: border,
    borderColor: 5,
    borderRadius: border ? 4 : 0,
    paddingLength: 6,
    containerID: id,
    containerName: name,
    content,
    isEventCapture: capture ? 1 : 0,
  })
}

function single(kind: ScreenKind, content: string): Screen {
  return { kind, layout: 'single', text: [container(1, 'main', 0, 0, W, H, content, true)] }
}

export function buildScreen(s: ServerState | null, ctx: Ctx): Screen {
  if (!ctx.configured) return single('setup', `${TITLE}\n\nOpen the phone app and\nset the server address\nand the 6-digit pair code.`)
  if (!s) return single('offline', `${TITLE}\n\n${ctx.online ? 'Loading...' : 'Server unreachable.\nRetrying...'}`)

  if (s.mode === 'waiting') {
    return single('waiting', `${TITLE}\nStatus: waiting for the host\nto start\nQuestions collected: ${s.counts.collected}`)
  }

  if (s.mode === 'ended') {
    const e = s.ended ?? { answered: s.counts.answered, left: s.counts.open }
    return single('ended', `${TITLE}\nThe AMA has ended.\nAnswered: ${e.answered}\nNot reached: ${e.left}`)
  }

  if (s.mode === 'answered' && s.answered) {
    const a = s.answered
    const next = s.head ? `Next:\n${wrapClip(s.head.text, BODY_COLS, 2)}` : 'No more open questions.'
    return single(
      'answered',
      `${CHECK} Answered\n${oneLine(a.text)}\n` + (a.takeaway ? `- ${oneLine(a.takeaway, BODY_COLS - 2)}\n` : '') + `\n${next}\n\nSwipe up = undo`,
    )
  }

  if (s.mode === 'empty' || !s.head) {
    return single('empty', `${TITLE}\nLive${timeLeft(s) ? ` ${DOT} ${timeLeft(s)}` : ''}\nNo open questions yet.\nAnswered so far: ${s.counts.answered}`)
  }

  // the next question: header, the question (the one container that takes input), hint
  const header = container(1, 'head', 0, 0, W, 44, headerLine(s), false)
  const body = container(2, 'question', 0, 48, W, 196, wrapClip(s.head.text), true, 1)
  const hint = container(3, 'hint', 0, 248, W, 40, ctx.flash || (ctx.online ? HINT : 'Offline, retrying...'), false)
  return { kind: 'question', layout: 'question', text: [header, body, hint] }
}

export function toCreate(sc: Screen): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({ containerTotalNum: sc.text.length, textObject: sc.text })
}

export function toRebuild(sc: Screen): RebuildPageContainer {
  return new RebuildPageContainer({ containerTotalNum: sc.text.length, textObject: sc.text })
}
