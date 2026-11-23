/**
 * Checks the Telegram bot token without printing it: prints its length, a shape check and the getMe result
 * (HTTP status and whether the bot can join groups). getMe is a free, read-only call.
 *   scripts/keychain-env.sh npx tsx scripts/check-token.ts
 */
const raw = process.env.TELEGRAM_BOT_TOKEN ?? ''
const t = raw.trim()
console.log(`TELEGRAM_BOT_TOKEN: length=${raw.length} trimmed=${t.length} looks_like_bot_token=${/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(t)}`)
if (t) {
  const res = await fetch(`https://api.telegram.org/bot${t}/getMe`)
  let ok = false
  let canJoin: unknown = '?'
  try {
    const j = (await res.json()) as { ok?: boolean; result?: { can_join_groups?: boolean } }
    ok = !!j.ok
    canJoin = j.result?.can_join_groups
  } catch {}
  console.log(`telegram getMe: http=${res.status} ok=${ok} can_join_groups=${canJoin}`)
}
