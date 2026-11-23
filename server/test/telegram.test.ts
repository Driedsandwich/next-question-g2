import { afterEach, describe, expect, it, vi } from 'vitest'
import { rulesMerger } from '../src/merger.ts'
import { Engine } from '../src/engine.ts'
import { TelegramSource, parseUpdate, voteCallbackData, type TgUpdate } from '../src/sources/telegram.ts'
import { FakeClock, MemLog, T0 } from './helpers.ts'

const TOKEN = '123456:TEST-TOKEN-NOT-REAL'
const CODE = '424242'
const GROUP = -100123
const PRESENTER = 111
const FAN = 222
const FAN2 = 333

interface Call {
  method: string
  params: Record<string, unknown>
}

function makeRig(opts: { chatId?: string; presenterId?: string; failSend?: boolean } = {}) {
  const calls: Call[] = []
  let urls: string[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    urls.push(url)
    const method = url.split('/').pop()!
    const params = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ method, params })
    if (opts.failSend && method === 'sendMessage') return new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 })
    return new Response(JSON.stringify({ ok: true, result: method === 'getMe' ? { username: 'NextQuestionBot' } : true }), { status: 200 })
  }
  const clock = new FakeClock(T0)
  const src = new TelegramSource({ token: TOKEN, pairCode: CODE, fetchImpl, chatId: opts.chatId, presenterId: opts.presenterId, clock })
  const engine = new Engine({ source: 'telegram', merger: rulesMerger, transcriber: null, log: new MemLog(), announcer: src.announcer, clock })
  ;(src as unknown as { sink: unknown }).sink = engine // start() would call getMe and begin polling: tests inject the sink instead
  return { src, engine, calls, urls: () => urls, clock }
}

let n = 0
const msg = (chatId: number, userId: number, text: string, chatType = chatId < 0 ? 'supergroup' : 'private'): TgUpdate => ({
  update_id: ++n,
  message: { message_id: 1000 + n, chat: { id: chatId, type: chatType }, from: { id: userId, is_bot: false }, text },
})
const press = (chatId: number, userId: number, data: string, messageId = 7): TgUpdate => ({
  update_id: ++n,
  callback_query: { id: `cb${n}`, from: { id: userId, is_bot: false }, message: { message_id: messageId, chat: { id: chatId, type: 'supergroup' } }, data },
})
const sent = (calls: Call[], method = 'sendMessage') => calls.filter((c) => c.method === method)

afterEach(() => vi.restoreAllMocks())

describe('parseUpdate', () => {
  it('reads /ask, /ask@Bot and ignores a command meant for another bot', () => {
    expect(parseUpdate(msg(GROUP, FAN, '/ask When is mainnet?'))).toMatchObject({ type: 'ask', text: 'When is mainnet?', chatId: GROUP, userKey: String(FAN) })
    expect(parseUpdate(msg(GROUP, FAN, '/ask@NextQuestionBot When is mainnet?'), { botUsername: 'nextquestionbot' })).toMatchObject({ type: 'ask', text: 'When is mainnet?' })
    expect(parseUpdate(msg(GROUP, FAN, '/ask@OtherBot When is mainnet?'), { botUsername: 'NextQuestionBot' })).toEqual({ type: 'ignore' })
  })
  it('reads /ama_start with minutes, without minutes and /ama_end', () => {
    expect(parseUpdate(msg(GROUP, PRESENTER, '/ama_start 45'))).toMatchObject({ type: 'ama_start', minutes: 45 })
    expect(parseUpdate(msg(GROUP, PRESENTER, '/ama_start'))).toMatchObject({ type: 'ama_start', minutes: undefined })
    expect(parseUpdate(msg(GROUP, PRESENTER, '/ama_end'))).toMatchObject({ type: 'ama_end' })
  })
  it('reads a vote button press and ignores callback data it did not create', () => {
    expect(parseUpdate(press(GROUP, FAN, voteCallbackData('q12')))).toMatchObject({ type: 'vote', qid: 'q12', userKey: String(FAN) })
    expect(parseUpdate(press(GROUP, FAN, 'v:../../x'))).toEqual({ type: 'ignore' })
    expect(parseUpdate(press(GROUP, FAN, 'zzz'))).toEqual({ type: 'ignore' })
  })
  it('ignores plain chat, other commands and messages from bots', () => {
    expect(parseUpdate(msg(GROUP, FAN, 'hello everyone'))).toEqual({ type: 'ignore' })
    expect(parseUpdate(msg(GROUP, FAN, '/unknown thing'))).toEqual({ type: 'ignore' })
    const bot = msg(GROUP, FAN, '/ask When is mainnet?')
    bot.message!.from!.is_bot = true
    expect(parseUpdate(bot)).toEqual({ type: 'ignore' })
  })
  it('callback_data stays within 64 bytes', () => {
    expect(Buffer.byteLength(voteCallbackData('q' + '9'.repeat(19)))).toBeLessThanOrEqual(64)
  })
})

describe('presenter and pairing', () => {
  it('refuses /ama_start from someone who is not the paired presenter', async () => {
    const t = makeRig({ chatId: String(GROUP) })
    await t.src.handle(msg(GROUP, FAN, '/ama_start 30'))
    expect(t.engine.getState().session.status).toBe('waiting')
    expect(sent(t.calls)[0]!.params.text).toContain('Only the paired presenter')
  })
  it('refuses /ama_end from a non-presenter too', async () => {
    const t = makeRig({ chatId: String(GROUP), presenterId: String(PRESENTER) })
    await t.src.handle(msg(GROUP, PRESENTER, '/ama_start 30'))
    await t.src.handle(msg(GROUP, FAN, '/ama_end'))
    expect(t.engine.getState().session.status).toBe('live')
  })
  it('pairs only in a private chat; /pair in a group is refused even with the right code', async () => {
    const t = makeRig()
    await t.src.handle(msg(GROUP, PRESENTER, `/pair ${CODE}`))
    expect(sent(t.calls)[0]!.params.text).toContain('private chat')
    await t.src.handle(msg(GROUP, PRESENTER, '/ama_start 30'))
    expect(t.engine.getState().session.status).toBe('waiting') // still not the presenter
    await t.src.handle(msg(PRESENTER, PRESENTER, `/pair ${CODE}`))
    await t.src.handle(msg(GROUP, PRESENTER, '/ama_start 30'))
    expect(t.engine.getState().session).toMatchObject({ status: 'live', minutes: 30 })
  })
  it('a wrong code does not pair, and 5 wrong codes lock pairing for 10 minutes', async () => {
    const t = makeRig()
    for (let i = 0; i < 5; i++) await t.src.handle(msg(FAN, FAN, '/pair 000000'))
    await t.src.handle(msg(FAN, FAN, `/pair ${CODE}`)) // right code, but locked
    await t.src.handle(msg(GROUP, FAN, '/ama_start 30'))
    expect(t.engine.getState().session.status).toBe('waiting')
    t.clock.advance(10 * 60 * 1000 + 1)
    await t.src.handle(msg(FAN, FAN, `/pair ${CODE}`))
    await t.src.handle(msg(GROUP, FAN, '/ama_start 30'))
    expect(t.engine.getState().session.status).toBe('live')
  })
  it('/ama_start binds the group, announces there, and /ama_end posts the summary', async () => {
    const t = makeRig({ presenterId: String(PRESENTER) })
    await t.src.handle(msg(GROUP, PRESENTER, '/ama_start 20'))
    const first = sent(t.calls)[0]!
    expect(first.params.chat_id).toBe(GROUP)
    expect(String(first.params.text)).toContain('20 min')
    await t.src.handle(msg(GROUP, PRESENTER, '/ama_end'))
    expect(String(sent(t.calls).at(-1)!.params.text)).toContain('The AMA has ended')
  })
  it('/ama_start in a private chat or in a group other than TELEGRAM_CHAT_ID does nothing', async () => {
    const t = makeRig({ chatId: String(GROUP), presenterId: String(PRESENTER) })
    await t.src.handle(msg(PRESENTER, PRESENTER, '/ama_start 30'))
    await t.src.handle(msg(-999, PRESENTER, '/ama_start 30'))
    expect(t.engine.getState().session.status).toBe('waiting')
  })
})

describe('questions and votes over Telegram', () => {
  it('/ask adds a question and replies with a +1 button', async () => {
    const t = makeRig({ chatId: String(GROUP), presenterId: String(PRESENTER) })
    await t.src.handle(msg(GROUP, FAN, '/ask When is the mainnet launch?'))
    const reply = sent(t.calls)[0]!
    expect(reply.params.chat_id).toBe(GROUP)
    expect(String(reply.params.text)).toContain('When is the mainnet launch?')
    const btn = (reply.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0]![0]!
    expect(btn.text).toContain('▲')
    expect(Buffer.byteLength(btn.callback_data)).toBeLessThanOrEqual(64)
    expect(t.engine.getState().counts.collected).toBe(1)
  })
  it('a similar /ask is merged and the reply says so', async () => {
    const t = makeRig({ chatId: String(GROUP) })
    await t.src.handle(msg(GROUP, FAN, '/ask When is the mainnet launch?'))
    await t.src.handle(msg(GROUP, FAN2, '/ask What is the planned date for mainnet release?'))
    expect(String(sent(t.calls)[1]!.params.text)).toContain('Merged')
    expect(t.engine.getState().counts).toMatchObject({ open: 1, collected: 1 })
    expect(t.engine.questions()[0]!.votes).toBe(2)
  })
  it('a button press adds one vote, answers the callback, and a second press by the same person does not count', async () => {
    const t = makeRig({ chatId: String(GROUP) })
    await t.src.handle(msg(GROUP, FAN, '/ask When is the mainnet launch?'))
    const qid = t.engine.questions()[0]!.id
    await t.src.handle(press(GROUP, FAN2, voteCallbackData(qid)))
    await t.src.handle(press(GROUP, FAN2, voteCallbackData(qid)))
    expect(t.engine.questions()[0]!.votes).toBe(2)
    expect(sent(t.calls, 'answerCallbackQuery')).toHaveLength(2) // always answered: it stops the spinner
    expect(sent(t.calls, 'answerCallbackQuery')[1]!.params.text).toBe('You already voted')
    expect(sent(t.calls, 'editMessageReplyMarkup')).toHaveLength(1)
  })
  it('a press on a question that was merged away counts for the question it was merged into', async () => {
    const t = makeRig({ chatId: String(GROUP) })
    t.engine['deps'].merger = async () => null // keep both open, then merge by proposal
    await t.src.handle(msg(GROUP, FAN, '/ask When is the mainnet launch?'))
    await t.src.handle(msg(GROUP, FAN2, '/ask What is the planned date for mainnet release?'))
    const [x, y] = t.engine.questions()
    expect(t.engine.proposeMerge(y!.id, x!.id).status).toBe('applied')
    await t.src.handle(press(GROUP, 444, voteCallbackData(y!.id)))
    expect(t.engine.questions()).toHaveLength(1)
    expect(t.engine.questions()[0]).toMatchObject({ id: x!.id, votes: 3 })
  })
  it('/ask outside the bound group, in a private chat, or with no text is not added', async () => {
    const t = makeRig({ chatId: String(GROUP) })
    await t.src.handle(msg(-555, FAN, '/ask Who funds the foundation?'))
    await t.src.handle(msg(FAN, FAN, '/ask Who funds the foundation?'))
    await t.src.handle(msg(GROUP, FAN, '/ask'))
    expect(t.engine.getState().counts.collected).toBe(0)
    expect(String(sent(t.calls)[2]!.params.text)).toContain('Usage')
  })
  it('an answer on the glasses is posted to the group as "Answered: ..." and with a takeaway', async () => {
    const t = makeRig({ chatId: String(GROUP), presenterId: String(PRESENTER) })
    await t.src.handle(msg(GROUP, PRESENTER, '/ama_start 30'))
    await t.src.handle(msg(GROUP, FAN, '/ask Who funds the foundation?'))
    await t.engine.answer()
    await t.engine.close()
    expect(String(sent(t.calls).at(-1)!.params.text)).toBe('✅ Answered: Who funds the foundation?')
    await t.src.handle(msg(GROUP, FAN, '/ask How do you keep bridge transfers safe?'))
    await t.engine.answer({ takeaway: 'Audited twice' })
    await t.engine.close()
    expect(String(sent(t.calls).at(-1)!.params.text)).toBe('✅ How do you keep bridge transfers safe? — Audited twice')
  })
})

describe('privacy and errors', () => {
  it('no user id or name appears in the state, the question list, or any posted text', async () => {
    const t = makeRig({ chatId: String(GROUP), presenterId: String(PRESENTER) })
    await t.src.handle(msg(GROUP, PRESENTER, '/ama_start 30'))
    await t.src.handle(msg(GROUP, 87654321, '/ask Who funds the foundation?'))
    await t.src.handle(press(GROUP, 76543210, voteCallbackData('q1')))
    const everything = JSON.stringify([t.engine.getState(), t.engine.questions(), t.engine.getSummary(), t.calls.filter((c) => c.method === 'sendMessage')])
    expect(everything).not.toContain('87654321')
    expect(everything).not.toContain('76543210')
  })
  it('a failing API call is logged without the URL (the URL holds the token)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = makeRig({ chatId: String(GROUP), failSend: true })
    await t.src.handle(msg(GROUP, FAN, '/ask Who funds the foundation?'))
    const logged = err.mock.calls.flat().join(' ')
    expect(logged).toContain('sendMessage')
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain('api.telegram.org')
    expect(t.urls().every((u) => u.startsWith('https://api.telegram.org/bot'))).toBe(true)
  })
})
