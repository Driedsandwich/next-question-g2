# Next Question

During an AMA (ask-me-anything session) in a **Telegram group**, your Even Realities G2 smart glasses (G2) show **one thing: the next question to answer**.
Audience members send `/ask <question>`; the asker's own vote is counted automatically, and other participants add votes by tapping the bot's `▲ +1` button (the same account cannot vote twice on a question). Similar questions are merged into one and their votes add up.
You see, for example, `AMA · 12 votes · 3 of 17 · 18 min left` and `When is mainnet?`.

Demo video: https://youtu.be/jWozJNgkZos · Verification status: see "Status" below and "Not verified yet" at the end · Run it in replay mode (no keys, no network): see Quick start.

- **Tap** = answered. After a 4-second undo window, the bot posts `✅ Answered: <question>` to the group.
- **Swipe down** = skip (the question goes to the back of the line). **Swipe up** = go back one step.
- **Hold** and say the key point of your answer in about 5 words. After the same 4-second undo window, the bot posts `✅ <question> — <key point>` to the group.
- **Double tap** = the system "exit?" window.

Status (25 November 2026): checked in the Even Hub simulator with the replay AMA (question -> answer -> skip -> answer -> end), 79 server tests pass, the glasses build and `.ehpk` (Even Hub app package) packing pass, and all four MCP (Model Context Protocol, for AI agents) tools were called end to end against the replay server. Not yet run on a device or against the real Telegram, LLM or speech services (see "Not verified yet").

## How it works

In the diagram, `answered.jsonl` is a JSON Lines (JSONL) file.

```
 Telegram group (audience)          (or)  fixtures/questions.json
  /ask  ▲ +1 button                       fictional AMA replayed with the current time
        |  Bot API getUpdates (long polling)        |
        v                                           v
   +--------------------------------------------------------+
   |  server  (Node 22, TypeScript)                         |   tokens and keys live only here
   |  question source -> merger (rules | LLM) -> queue      |
   |  order: votes, then oldest; skipped = back of the line |--> data/answered.jsonl
   |  answer (4 s undo window) -> bot posts to the group    |--> Telegram sendMessage
   |  HTTP + SSE        MCP (stdio)                         |<-- LLM / STT (optional, OpenAI-compatible)
   +----------+-----------------------+---------------------+
              |                       |
   phone WebView (Even app)        AI agents (Claude, etc.)
   glasses/  (Vite + Even Hub SDK)   list_questions, get_next_question,
     -> 576x288 screens on the G2      propose_merge, get_session_summary
```

Glasses screens (green, text only, no font control):

1. Waiting: `NEXT QUESTION · AMA`, the state of the AMA, how many questions were collected.
2. Next question: header `AMA · 12 votes · 3 of 17 · 18 min left`, the question (wrapped at 52 characters, cut after 5 lines with `...`), and the hint `Tap = answered · Swipe = skip · Hold = say answer`. One container takes the input; there are 3 containers in total (the limit is 12).
3. Answered: `● Answered`, what was answered, the start of the next question, `Swipe up = undo`.
4. Ended: how many were answered and how many were not reached.

"3 of 17" means: you are on the 3rd question to address, out of 17 (answered so far + still open). Skipping does not change it.

## Quick start

```bash
# 1. server (replay mode: fictional questions, no network, no keys)
npm --prefix server install
npm --prefix server start
#   prints a 6-digit pair code. The replay opens a 30-minute AMA and feeds 23 asks in about 2.5 minutes
#   (3 of them repeat an earlier question and are merged). Set REPLAY_SPEED=4 to go four times faster.

# 2. glasses app
npm --prefix glasses install
npm --prefix glasses run dev          # http://localhost:5173

# 3. simulator (npm install -g @evenrealities/evenhub-simulator)
evenhub-simulator "http://localhost:5173/?server=http://localhost:8788&pair=<code>"
#    or run demo/run-scene.sh <script.json> <out-dir> to start server, app and simulator
#    together and record the glasses screen (see demo/README.md)
```

Tests and build:

```bash
npm --prefix server test              # vitest, offline (network is blocked in the test setup)
npm --prefix server run typecheck
npm --prefix glasses run build
npm --prefix glasses run pack         # -> glasses/next-question.ehpk
npm --prefix glasses run check:pages  # offline screen/container rule check
```

Environment variables and the HTTP interface are listed in Reference at the end.

Real device: the phone cannot reach `localhost` of your computer. Use your computer's LAN address as the server address and add that address to the `network` whitelist in `glasses/app.json` before packing. The server port is **8788** (fill-notes uses 8787).

## Using a real Telegram group

1. Create a bot with @BotFather and keep the token private. Leave **privacy mode on** (the default): in groups the bot then receives only commands meant for it, replies to it and button presses, not the normal chat.
2. Put the token in a local `.env` (copy `env.example`, which has names only): `QUESTION_SOURCE=telegram`, `TELEGRAM_BOT_TOKEN=...`.
3. Add the bot to the group. Start the server.
4. Pair the presenter: send `/pair <6-digit code>` to the bot in a **private chat** (the code is printed when the server starts). `/pair` in a group is refused, because the same code opens the glasses connection. Five wrong codes lock pairing for 10 minutes.
   Or set `TELEGRAM_PRESENTER_ID` (numeric user id) and skip pairing.
5. In the group, the presenter sends `/ama_start 30`. The bot binds to that group (or to `TELEGRAM_CHAT_ID` if set), posts an opening line, and `/ask` starts working. `/ama_end` ends it and posts the counts. Both commands are refused for anyone who is not the paired presenter.

Audience: `/ask <question>` (the bot replies with the question and a `▲ +1 (n)` button; a repeat of an open question is merged and says so). The asker's own vote is counted automatically. Other participants tap the button to add a vote. One vote per person per question, so the asker cannot add another vote to their own question.

## How questions are merged and ordered

- **Rules merger (default):** lower-case, drop punctuation and filler words, light stemming, a few synonyms (`date`/`timeline` → "when", `release`/`live` → "launch"). Two questions are the same if they share at least 2 content words and at least 60% of all their words, or share a word and at least 80%. The numbers were tuned on 3 paraphrase pairs and 5 look-alike pairs in `server/test/merger.test.ts` (at 50% "When is the mainnet launch?" and "When is the testnet launch?" were folded together, so it is 60%). Known limit: two different questions that share almost all their words can still be folded. It works on space-separated languages; Japanese and other unspaced text merges only when the words are the same.
- **LLM merger:** the model sees the open questions and the new one and must answer `{"match":"<id>"}` or `{"match":null}`. Anything else, an error or a timeout falls back to the rules. The question texts are sent to the model you configure, so leave it off if the audience should not be sent to a third party.
- **Order:** never-skipped first; then more votes first; then the earlier question. A skipped question goes behind every unskipped one (and behind earlier skips). The asker counts as the first vote.
- **Answer window:** an answer shows `● Answered` for 4 seconds. Only after that is it posted to the group and written to `data/answered.jsonl`. Swipe up inside the window takes it back and nothing is posted. After that, swipe up only undoes skips (a posted message cannot be unsent).

## MCP (for AI agents)

```bash
npm --prefix server run mcp      # stdio server; point your MCP client at this command
```

Tools: `list_questions`, `get_next_question`, `propose_merge`, `get_session_summary` (answered, remaining, top words by votes).
An AI can only *propose* a merge. The queue changes only if the server's own word-overlap rule agrees; otherwise the proposal stays pending and nothing changes. There is no glasses gesture to confirm a pending proposal (all gestures are used), so a rejected proposal is simply not applied.
Question texts are written by the audience: the tools say so in every answer, and an agent should treat them as data, not as instructions.

## Safety and privacy

- **No names.** The bot reads only Telegram user ids, and only in memory (to stop double votes and to know who the presenter is). Names and usernames are never read. Ids are not in `/api/state`, the question list, the MCP answers, the posted messages or `data/answered.jsonl` (a test checks this). Restarting forgets them.
- **Minimal storage.** `data/answered.jsonl` holds, per answered question: time, id, question text, vote count, key point, source. Nothing else is saved. The question text itself is written by the audience and could contain a name; the bot's `/help` says the text is shown on the glasses and kept in a local log.
- **Secrets.** The bot token, LLM and STT keys exist only in the server's environment (`.env`, git-ignored). The glasses app and the MCP process never see them. `env.example` contains names only. The Bot API path contains the token, so error logs never print the request URL (a test checks this).
- **Telegram rules.** The app uses question text only to show and answer it, sends 1 to 3 messages per question, and deletes nothing by itself: the operator deletes `data/answered.jsonl` when it is no longer needed or on request. The operator follows the group's own rules and Telegram's terms, and should tell the group that questions are shown to the presenter and logged.
- **Prompt injection.** A question can say anything. It is only shown as text and passed to the optional merger as data. The MCP answers carry a warning.
- **Merger and voice.** With `MERGER=openai-compatible` the questions are sent to the model you configure; with `STT=openai-compatible` your spoken key point is sent to the speech service. Both are off by default.
- The demo is a fictional AMA (`server/fixtures/questions.json`) for a made-up project.

## What existed before the build period (started 2026-11-23)

Not written for this project:

- Even Hub SDK `@evenrealities/even_hub_sdk` 0.0.16, the Even Hub CLI `@evenrealities/evenhub-cli` 0.2.0, the Even Hub simulator `@evenrealities/evenhub-simulator`, and the official guides for Even Hub (read from a local copy).
- npm packages: Vite, TypeScript, vitest, tsx, `@modelcontextprotocol/sdk`, zod.
- Services and APIs: the Telegram Bot API, the OpenAI-compatible chat and transcription API shapes, the Model Context Protocol.

Reused from `fill-notes` (a project by the same entrant, made on 2026-11-24): the pairing code (`pairing.ts`), the speech-to-text client (`stt.ts`), the HTTP/SSE/CORS server layout, the glasses fetch and SSE client, the settings screen, `background.ts`, the tsconfig and vite config, the test setup that blocks the network, and the README outline.
Written for this project: the question queue and merger, the Telegram source, the replay fixture, the answer window and undo, the screens, the input mapping and the MCP tools.

## How AI tools were used

AI assistants did the building: Claude Code wrote the code, tests and documentation; ChatGPT wrote first drafts of the description and the demo script; Codex made design mockups. The entrant chose the project's subject and the glasses screen layout from options the AI proposed, and submits the work.

## Not verified yet

- Anything on real G2 hardware: receiving a long press and the other gestures, display width and line wrapping, and glyph shapes (whether `▲` and `●` render).
- The background-state hooks (`background.ts` follows the guide's host contract; SDK 0.0.16 does not export the named functions).
- The real Telegram Bot API, a real LLM and a real speech service (only offline tests with injected `fetch`). Telegram flood limits and edits of the vote button under many simultaneous votes are untested.
- Whether `http://` server addresses are accepted by the Even app WebView outside the simulator.

## Reference

### Environment variables

| Name | Default | Meaning |
|---|---|---|
| `PORT` | `8788` | HTTP port |
| `QUESTION_SOURCE` | `replay` | `replay` or `telegram` |
| `MERGER` | `rules` | `rules` (offline) or `openai-compatible` (falls back to rules on any error) |
| `STT` | `none` | `none` (voice answers 501) or `openai-compatible` |
| `DATA_DIR` | `./data` | pair code and `answered.jsonl` |
| `TELEGRAM_BOT_TOKEN` | none | bot token (server only) |
| `TELEGRAM_CHAT_ID` | none | only use this group (numeric id); otherwise the group of `/ama_start` |
| `TELEGRAM_PRESENTER_ID` | none | numeric id of the presenter; otherwise pair with `/pair` |
| `REPLAY_SPEED`, `REPLAY_SESSION_MIN` | `1`, `30` | replay pacing and the length of the replay AMA |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | none | OpenAI-compatible chat completions (used by `MERGER=openai-compatible`) |
| `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL` | `whisper-1` for the model | OpenAI-compatible `/audio/transcriptions` |
| `NEXT_QUESTION_URL` | `http://localhost:8788` | used by the MCP process to reach the server |

### HTTP interface

Every route except `GET /api/health` needs `Authorization: Pair <6-digit code>`. The code is created on first start and saved in `data/pair.json`.

| Route | Purpose |
|---|---|
| `GET /api/state` | current state (mode: waiting, empty, question, answered, ended; head question, position, minutes left) |
| `GET /api/events` | Server-Sent Events: a `state` event on every change (read with fetch streaming, because `EventSource` cannot send headers) |
| `POST /api/answer`, `POST /api/skip` | `{id}`: the question on screen. A different id (the screen was out of date) is refused with 409 |
| `POST /api/back` | undo the last skip, or the last answer while its window is open |
| `POST /api/voice?id=` | raw 16 kHz 16-bit mono PCM; transcribed and used as the key point of the answer. 501 when `STT=none` |
| `POST /api/session` | `{action:"start", minutes}`, `{action:"end"}`, `{action:"set_minutes", minutes}` |
| `GET /api/questions`, `GET /api/summary`, `POST /api/propose-merge` | used by the MCP tools |

### About this repository's history

This public repository is a copy of the private development repository, with the same commits, authors, dates and messages. In the copy, one line in older versions of the demo recording script was changed: it held a path on the developer's machine. This changes the commit IDs from the first affected commit onward; the current files are identical to the development repository.
