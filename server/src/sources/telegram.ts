/**
 * Telegram Bot API source (long polling with getUpdates).
 * Method and field names were read from https://core.telegram.org/bots/api on 2026-11-24.
 *
 * Privacy rules kept here:
 *  - Telegram user ids are used in memory only (to stop double votes and to know who the presenter is).
 *    They are never put in the state, the logs, the answers or the files. Names and usernames are never read.
 *  - The bot token sits in the request path of the Bot API. Error messages here never include the URL.
 */
import { checkPairCode, MAX_PAIR_FAILS, PAIR_LOCK_MS, rememberPairAttempt } from '../pairing.ts'
import type { Sink, QuestionSource } from '../sources.ts'
import type { Announcer, Clock, FetchLike } from '../types.ts'
import { systemClock } from '../types.ts'

// ---------- the parts of the Bot API objects we read ----------

export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel' | string
}
export interface TgUser {
  id: number
  is_bot?: boolean
}
export interface TgMessage {
  message_id: number
  chat: TgChat
  from?: TgUser
  text?: string
}
export interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: { message_id: number; chat: TgChat }
  data?: string
}
export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}

// ---------- reading an update (pure: no network, no state) ----------

interface Who {
  chatId: number
  chatType: string
  userKey: string // Telegram user id as a string. In memory only.
}

export type Action =
  | ({ type: 'ask'; text: string; messageId: number } & Who)
  | ({ type: 'vote'; qid: string; callbackId: string; messageId: number } & Who)
  | ({ type: 'pair'; code: string } & Who)
  | ({ type: 'ama_start'; minutes: number | undefined } & Who)
  | ({ type: 'ama_end' } & Who)
  | ({ type: 'help' } & Who)
  | { type: 'ignore' }

const CALLBACK_RE = /^v:([a-z0-9]{1,20})$/
const COMMAND_RE = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,32}))?(?:\s+([\s\S]*))?$/

export function voteCallbackData(qid: string): string {
  return `v:${qid}` // at most 64 bytes: ids look like "q123"
}

export function parseUpdate(u: TgUpdate, ctx: { botUsername?: string } = {}): Action {
  const cq = u.callback_query
  if (cq) {
    const m = CALLBACK_RE.exec(cq.data ?? '')
    if (!m || !cq.message || cq.from.is_bot) return { type: 'ignore' }
    return {
      type: 'vote',
      qid: m[1]!,
      callbackId: cq.id,
      messageId: cq.message.message_id,
      chatId: cq.message.chat.id,
      chatType: cq.message.chat.type,
      userKey: String(cq.from.id),
    }
  }
  const msg = u.message
  if (!msg || typeof msg.text !== 'string' || !msg.from || msg.from.is_bot) return { type: 'ignore' }
  const m = COMMAND_RE.exec(msg.text.trim())
  if (!m) return { type: 'ignore' }
  const [, cmdRaw, target, rest = ''] = m
  if (target && ctx.botUsername && target.toLowerCase() !== ctx.botUsername.toLowerCase()) return { type: 'ignore' } // meant for another bot
  const who: Who = { chatId: msg.chat.id, chatType: msg.chat.type, userKey: String(msg.from.id) }
  switch (cmdRaw!.toLowerCase()) {
    case 'ask':
      return { type: 'ask', text: rest.trim(), messageId: msg.message_id, ...who }
    case 'pair':
      return { type: 'pair', code: rest.trim(), ...who }
    case 'ama_start': {
      const n = Number(rest.trim())
      return { type: 'ama_start', minutes: rest.trim() !== '' && Number.isFinite(n) ? n : undefined, ...who }
    }
    case 'ama_end':
      return { type: 'ama_end', ...who }
    case 'start':
    case 'help':
      return { type: 'help', ...who }
    default:
      return { type: 'ignore' }
  }
}

// ---------- the source ----------

export class TelegramApiError extends Error {
  constructor(
    public method: string,
    public status: number,
    description: string,
    public retryAfter?: number,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`)
  }
}

export interface TelegramOptions {
  token: string
  pairCode: string
  fetchImpl?: FetchLike
  /** Only this chat is used for questions. When empty, the chat where the presenter runs /ama_start is used. */
  chatId?: string
  /** Telegram user id of the presenter. When empty, the presenter pairs with /pair in a private chat. */
  presenterId?: string
  pollSeconds?: number
  clock?: Clock
  apiBase?: string
}

export class TelegramSource implements QuestionSource, Announcer {
  readonly name = 'telegram' as const
  readonly announcer: Announcer = this
  private doFetch: FetchLike
  private sink: Sink | null = null
  private botUsername: string | undefined
  private boundChat: number | null
  private presenter: string | null
  private offset = 0
  private stopped = false
  private ctrl: AbortController | null = null
  private pairAttempts = new Map<string, { fails: number; lockedUntil?: number }>()
  private clock: Clock

  constructor(private opts: TelegramOptions) {
    this.doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i))
    this.clock = opts.clock ?? systemClock
    this.boundChat = opts.chatId && /^-?\d+$/.test(opts.chatId) ? Number(opts.chatId) : null
    this.presenter = opts.presenterId ? opts.presenterId : null
  }

  // --- Bot API calls ---

  private async api<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const url = `${this.opts.apiBase ?? 'https://api.telegram.org'}/bot${this.opts.token}/${method}`
    let res: Response
    try {
      res = await this.doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal })
    } catch (e) {
      if (signal?.aborted) throw e
      throw new TelegramApiError(method, 0, 'network error') // never echo the URL: it contains the token
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }
    if (!res.ok || !json.ok) throw new TelegramApiError(method, res.status, json.description ?? 'no description', json.parameters?.retry_after)
    return json.result as T
  }

  private async send(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.api('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_notification: true, ...extra })
    } catch (e) {
      console.error(`[telegram] ${(e as Error).message}`)
    }
  }

  /** Announcer: post a line to the AMA group. Dropped (with a log line) when no group is bound yet. */
  async announce(text: string): Promise<void> {
    if (this.boundChat === null) {
      console.error('[telegram] no group bound yet: announcement dropped')
      return
    }
    await this.send(this.boundChat, text)
  }

  private voteKeyboard(qid: string, votes: number) {
    return { inline_keyboard: [[{ text: `▲ +1 (${votes})`, callback_data: voteCallbackData(qid) }]] }
  }

  // --- handling ---

  private isPresenter(userKey: string): boolean {
    return this.presenter !== null && this.presenter === userKey
  }

  /** Runs one update. Exposed for tests (they pass a fake fetch). */
  async handle(u: TgUpdate): Promise<Action> {
    const sink = this.sink
    const a = parseUpdate(u, { botUsername: this.botUsername })
    if (!sink || a.type === 'ignore') return a
    const isGroup = a.chatType === 'group' || a.chatType === 'supergroup'

    switch (a.type) {
      case 'help':
        await this.send(
          a.chatId,
          'Next Question: send /ask <your question> in the AMA group, then tap ▲ +1 on the questions you want answered. Similar questions are merged. Your question text is shown on the presenter\'s glasses and kept in a local log; your name and Telegram id are not stored. The presenter pairs with /pair <code> in a private chat with me.',
        )
        break

      case 'pair': {
        if (a.chatType !== 'private') {
          await this.send(a.chatId, 'Send /pair in a private chat with me, not in a group: the code must stay secret. If you typed the real code here, delete that message, then delete data/pair.json on the server and restart it to get a new code.')
          break
        }
        const now = this.clock.now()
        const attempts = this.pairAttempts.get(a.userKey)
        if (attempts?.lockedUntil !== undefined) {
          if (now < attempts.lockedUntil) break
          this.pairAttempts.delete(a.userKey)
        }
        if (checkPairCode(a.code, this.opts.pairCode)) {
          this.pairAttempts.delete(a.userKey)
          this.presenter = a.userKey
          await this.send(a.chatId, 'Paired. You are the presenter: run /ama_start <minutes> in the AMA group.')
        } else {
          const fails = (attempts?.fails ?? 0) + 1
          const next = fails >= MAX_PAIR_FAILS ? { fails: 0, lockedUntil: now + PAIR_LOCK_MS } : { fails }
          rememberPairAttempt(this.pairAttempts, a.userKey, next)
          await this.send(a.chatId, 'That code is not right.')
        }
        break
      }

      case 'ama_start':
      case 'ama_end': {
        if (!this.isPresenter(a.userKey)) {
          await this.send(a.chatId, 'Only the paired presenter can do this.')
          break
        }
        try {
          if (a.type === 'ama_start') {
            if (!isGroup) {
              await this.send(a.chatId, 'Run /ama_start in the AMA group.')
              break
            }
            if (this.boundChat !== null && this.boundChat !== a.chatId) {
              await this.send(a.chatId, 'This server is set to a different group (TELEGRAM_CHAT_ID).')
              break
            }
            this.boundChat = a.chatId // from here on, announcements go to this group
            await sink.startSession(a.minutes)
          } else {
            if (this.boundChat !== null && this.boundChat !== a.chatId) break
            await sink.endSession()
          }
        } catch (e) {
          await this.send(a.chatId, `Not done: ${(e as Error).message}`)
        }
        break
      }

      case 'ask': {
        if (!isGroup || this.boundChat === null || this.boundChat !== a.chatId) {
          await this.send(a.chatId, 'No AMA is open in this chat. The presenter starts one with /ama_start <minutes>.')
          break
        }
        if (!a.text) {
          await this.send(a.chatId, 'Usage: /ask <your question>', { reply_parameters: { message_id: a.messageId } })
          break
        }
        try {
          const r = await sink.ask(a.text, a.userKey)
          const head = r.merged ? `Merged with a similar question (now ${r.votes}▲):` : 'Question added:'
          await this.send(a.chatId, `${head}\n${r.text}`, {
            reply_parameters: { message_id: a.messageId },
            reply_markup: this.voteKeyboard(r.id, r.votes),
          })
        } catch (e) {
          await this.send(a.chatId, `Not added: ${(e as Error).message}`, { reply_parameters: { message_id: a.messageId } })
        }
        break
      }

      case 'vote': {
        const r = sink.vote(a.qid, a.userKey)
        const text = r.added ? 'Voted' : r.status === 'answered' ? 'Already answered' : r.status === 'unknown' ? 'That question is gone' : 'You already voted'
        try {
          await this.api('answerCallbackQuery', { callback_query_id: a.callbackId, text }) // required: it stops the spinner
        } catch (e) {
          console.error(`[telegram] ${(e as Error).message}`)
        }
        if (r.added && r.id) {
          try {
            await this.api('editMessageReplyMarkup', { chat_id: a.chatId, message_id: a.messageId, reply_markup: this.voteKeyboard(r.id, r.votes) })
          } catch (e) {
            console.error(`[telegram] ${(e as Error).message}`)
          }
        }
        break
      }
    }
    return a
  }

  // --- lifecycle ---

  async start(sink: Sink): Promise<void> {
    this.sink = sink
    const me = await this.api<{ username?: string }>('getMe', {})
    this.botUsername = me.username
    console.log(`  telegram  : bot @${me.username ?? '?'} ready (privacy mode keeps the bot to commands and button presses)`)
    void this.pollLoop()
  }

  private async pollLoop(): Promise<void> {
    const secs = this.opts.pollSeconds ?? 25
    while (!this.stopped) {
      this.ctrl = new AbortController()
      try {
        const ups = await this.api<TgUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout: secs, allowed_updates: ['message', 'callback_query'] },
          AbortSignal.any([this.ctrl.signal, AbortSignal.timeout((secs + 10) * 1000)]),
        )
        for (const u of ups) {
          this.offset = u.update_id + 1
          await this.handle(u).catch((e: Error) => console.error(`[telegram] handler: ${e.message}`))
        }
      } catch (e) {
        if (this.stopped) return
        const wait = e instanceof TelegramApiError && e.retryAfter ? e.retryAfter * 1000 : 3000
        console.error(`[telegram] poll failed: ${(e as Error).message}`)
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }

  stop(): void {
    this.stopped = true
    this.ctrl?.abort()
  }
}
