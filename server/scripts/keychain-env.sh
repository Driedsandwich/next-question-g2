#!/bin/zsh
# macOS only: read the Telegram bot token from the login keychain into the environment, then run a command.
# The value is never printed. If the item is missing, the variable stays empty.
#   scripts/keychain-env.sh npm start
#   scripts/keychain-env.sh npx tsx scripts/check-token.ts
k() { security find-generic-password -s "$1" -a "$USER" -w 2>/dev/null | tr -d '\r\n' || true; }
export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$(k nextquestion-telegram-bot-token)}"
exec "$@"
