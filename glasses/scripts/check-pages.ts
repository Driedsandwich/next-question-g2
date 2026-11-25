// Offline check of the screens. The SDK validator only covers z-order/menu rules, so the rules from the glasses-ui
// guide are asserted here too: <=12 containers, exactly one event capture, unique ids, unique names <=16 chars,
// text <=1000 chars. Also: the question text is at most 3 lines, and fixed text uses only characters known to be in the G2 font.
import { formatEvenHubPageContainerValidationError, validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import type { ServerState } from '../src/api.ts'
import { BODY_LINES, buildScreen, glassText, headerLine, toCreate, toRebuild, wrapClip } from '../src/screens.ts'

const base: ServerState = {
  version: 1,
  now: 0,
  mode: 'question',
  session: { status: 'live', minutes: 30, minutesLeft: 18, startedAt: 0, endsAt: 1_080_000 },
  head: { id: 'q9', text: 'When is mainnet?', votes: 12 },
  position: 3,
  total: 17,
  counts: { open: 15, answered: 2, collected: 17 },
  answered: null,
  ended: null,
}
const longText =
  'Hey team — you said the “treasury” would be spread across several wallets, so how will the community verify the balances every month without trusting a single dashboard or a spreadsheet?'
type Ctx = { configured: boolean; online: boolean; flash: string }
const ok: Ctx = { configured: true, online: true, flash: '' }
const cases: [string, ServerState | null, Ctx][] = [
  ['setup', null, { configured: false, online: false, flash: '' }],
  ['offline', null, { configured: true, online: false, flash: '' }],
  ['waiting', { ...base, mode: 'waiting', session: { ...base.session, status: 'waiting', minutesLeft: null }, head: null, counts: { open: 4, answered: 0, collected: 4 } }, ok],
  ['empty', { ...base, mode: 'empty', head: null, counts: { open: 0, answered: 3, collected: 3 } }, ok],
  ['question', base, ok],
  ['question/long+curly', { ...base, head: { id: 'q10', text: longText, votes: 120 } }, ok],
  ['question/one long word', { ...base, head: { id: 'q11', text: 'x'.repeat(300), votes: 1 } }, ok],
  ['question/listening', base, { ...ok, flash: 'Listening... release to send' }],
  ['question/offline', base, { ...ok, online: false }],
  ['question/time up', { ...base, session: { ...base.session, minutesLeft: 0 } }, ok],
  ['answered', { ...base, mode: 'answered', answered: { id: 'q8', text: 'Who funds the foundation?', takeaway: 'Audited twice, reports are public', msLeft: 3000, expiresAt: 3000 } }, ok],
  ['answered/no next', { ...base, mode: 'answered', head: null, answered: { id: 'q8', text: longText, takeaway: null, msLeft: 3000, expiresAt: 3000 } }, ok],
  ['ended', { ...base, mode: 'ended', session: { ...base.session, status: 'ended', minutesLeft: null }, ended: { answered: 12, left: 5 } }, ok],
]

// Characters allowed in text this app writes itself (the question text is checked separately by glassText).
const ALLOWED = /^[\x20-\x7e\n·▲●━─]*$/

function rules(sc: ReturnType<typeof buildScreen>): string[] {
  const all = sc.text
  const errs: string[] = []
  if (all.length > 12) errs.push('more than 12 containers')
  if (all.filter((c) => c.isEventCapture === 1).length !== 1) errs.push('need exactly one isEventCapture')
  if (new Set(all.map((c) => c.containerID)).size !== all.length) errs.push('duplicate containerID')
  if (new Set(all.map((c) => c.containerName)).size !== all.length) errs.push('duplicate containerName')
  if (all.some((c) => (c.containerName ?? '').length > 16)) errs.push('containerName > 16 chars')
  if (all.some((c) => (c.content ?? '').length > 1000)) errs.push('text > 1000 chars')
  if (all.some((c) => !ALLOWED.test(c.content ?? ''))) errs.push('a character outside the allowed set')
  if (sc.kind === 'question') {
    const body = sc.text.find((t) => t.containerName === 'question')
    if (!body || (body.content ?? '').split('\n').length > BODY_LINES) errs.push(`question text is more than ${BODY_LINES} lines`)
  }
  return errs
}

let bad = 0
for (const [name, s, ctx] of cases) {
  const sc = buildScreen(s, ctx)
  const re = rules(sc)
  if (re.length) {
    bad++
    console.log(`FAIL ${name}: ${re.join('; ')}`)
  }
  for (const [label, page] of [['create', toCreate(sc)], ['rebuild', toRebuild(sc)]] as const) {
    const r = validateEvenHubPageContainer(page as never)
    const valid = r.valid !== false && !('errors' in r && Array.isArray(r.errors) && r.errors.length)
    if (!valid) {
      bad++
      console.log(`FAIL ${name}/${label}: ${formatEvenHubPageContainerValidationError(r as never)}`)
    } else console.log(`ok   ${name}/${label}: ${sc.text.length} text containers`)
  }
  console.log('     ' + JSON.stringify(sc.text.map((t) => t.content ?? '').join(' | ')).slice(0, 170))
}

// a few direct checks
const checks: [string, boolean][] = [
  ['header line', headerLine(base) === 'AMA · 12 votes · 3 of 17 · 18 min left'],
  ['curly quotes and dashes become ASCII', glassText(longText).startsWith('Hey team - you said the "treasury"')],
  ['long text is cut with ...', wrapClip(longText + ' ' + longText).endsWith('...') && wrapClip(longText + ' ' + longText).split('\n').length === BODY_LINES],
  ['short text is untouched', wrapClip('When is mainnet?') === 'When is mainnet?'],
]
for (const [n, pass] of checks) {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${n}`)
  if (!pass) bad++
}
process.exit(bad ? 1 : 0)
