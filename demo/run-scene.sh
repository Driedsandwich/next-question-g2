#!/bin/bash
# run-scene.sh <script.json> <outDir>
# Starts the Next Question server (replay mode, fictional AMA), the glasses app (vite) and the Even Hub simulator,
# runs capture.mjs, then stops ONLY the processes it started (by PID / process group recorded in <outDir>/pids/).
# Never kills by port. Refuses to start when one of the three ports is already listening.
# Env overrides: SIM_JS, SERVER_PORT (8788), APP_PORT (5174), REPLAY_SPEED (1), CAPTURE_OFFSET_MS (default: script "serverOffsetSec" * 1000)
# Script fields used here: automationPort (9899), serverOffsetSec (capture t0 = this many seconds after the server's fixture clock starts)
set -u
set -m   # every background job gets its own process group (pgid == pid)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCRIPT="$(cd "$(dirname "${1:?usage: run-scene.sh <script.json> <outDir>}")" && pwd)/$(basename "$1")"
mkdir -p "${2:?usage: run-scene.sh <script.json> <outDir>}"
OUT="$(cd "$2" && pwd)"

SIM_JS="${SIM_JS:-}"
SERVER_PORT="${SERVER_PORT:-8788}"
APP_PORT="${APP_PORT:-5174}"
SPEED="${REPLAY_SPEED:-1}"
AUTO_PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).automationPort??9899)' "$SCRIPT")"
OFFSET_MS="${CAPTURE_OFFSET_MS:-$(node -e 'console.log(Math.round(1000*(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).serverOffsetSec??14)))' "$SCRIPT")}"
export PATH="$PATH:/opt/homebrew/bin"

listeners() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2 | wc -l | tr -d ' '; }

# Refuse to start if a port is already taken (we never kill by port).
for p in "$SERVER_PORT" "$APP_PORT" "$AUTO_PORT"; do
  if [ "$(listeners "$p")" != "0" ]; then
    echo "port $p is already in use by another process; nothing started, nothing stopped." >&2
    exit 3
  fi
done

mkdir -p "$OUT/pids" "$OUT/logs" "$OUT/data"
: > "$OUT/pids/all.txt"

tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do tree "$c"; done; echo "$1"; }

stop_one() {  # stop_one <name>
  local f="$OUT/pids/$1.pid" pid pids p i alive
  [ -f "$f" ] || return 0
  pid="$(cat "$f")"
  pids="$(tree "$pid")"
  if [ "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$pid" ]; then kill -TERM -- "-$pid" 2>/dev/null; fi
  for p in $pids; do kill -TERM "$p" 2>/dev/null; done
  for i in 1 2 3 4 5 6 7 8 9 10; do
    alive=0
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ $alive = 0 ] && break
    sleep 0.5
  done
  for p in $pids; do
    if kill -0 "$p" 2>/dev/null; then kill -KILL "$p" 2>/dev/null; echo "KILL needed for $1 pid $p" >> "$OUT/pids/all.txt"; fi
  done
  echo "stopped $1 (pid $pid; tree: $(echo $pids))" >> "$OUT/pids/all.txt"
}

# The simulator binary can outlive its node launcher. Kill only a binary whose command line carries OUR app URL (port $APP_PORT).
stop_sim_leftover() {
  local line pid
  while IFS= read -r line; do
    pid="${line%% *}"
    case "$line" in *"127.0.0.1:$APP_PORT/"*) kill -TERM "$pid" 2>/dev/null; sleep 1; kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null; echo "leftover simulator binary stopped by pid $pid" >> "$OUT/pids/all.txt" ;; esac
  done < <(pgrep -fl "sim-darwin-arm64/bin/evenhub-simulator" 2>/dev/null)
}

cleanup() {
  trap - EXIT INT TERM
  stop_one simulator; stop_one vite; stop_one server
  sleep 1
  stop_sim_leftover
  local simleft
  simleft="$(pgrep -fl "sim-darwin-arm64/bin/evenhub-simulator" 2>/dev/null | grep -c "127.0.0.1:$APP_PORT/")"
  echo "{\"afterStop\":{\"$SERVER_PORT\":$(listeners "$SERVER_PORT"),\"$APP_PORT\":$(listeners "$APP_PORT"),\"$AUTO_PORT\":$(listeners "$AUTO_PORT")},\"simulatorBinariesWithOurUrl\":${simleft:-0}}" > "$OUT/ports_after.json"
  cat "$OUT/ports_after.json"
  if [ -f "$OUT/report.json" ]; then
    node -e '
      const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));
      const a=JSON.parse(fs.readFileSync(process.argv[2]));
      r.listenersAfterStop=a.afterStop; r.simulatorBinariesWithOurUrlAfterStop=a.simulatorBinariesWithOurUrl;
      r.stopLog=fs.readFileSync(process.argv[3],"utf8").trim().split("\n");
      fs.writeFileSync(process.argv[1],JSON.stringify(r,null,2))' "$OUT/report.json" "$OUT/ports_after.json" "$OUT/pids/all.txt"
  fi
}
trap cleanup EXIT INT TERM

wait_http() {  # wait_http <url> <seconds>
  local i n=$(( $2 * 2 ))
  for ((i = 0; i < n; i++)); do curl -fsS -m 2 -o /dev/null "$1" 2>/dev/null && return 0; sleep 0.5; done
  return 1
}

stage() { echo "$(node -e 'console.log(Date.now())') $*" >> "$OUT/logs/stages.log"; }
: > "$OUT/logs/stages.log"

# Pairing code is written beforehand (server reads <DATA_DIR>/pair.json) so the app URL can carry it.
# Journal (answered.jsonl) and pairing live in <outDir>/data, not in the repo.
PAIR="$(printf '%06d' $(( (RANDOM * 32768 + RANDOM) % 1000000 )))"
echo "{\"code\":\"$PAIR\",\"createdAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}" > "$OUT/data/pair.json"

# 1. glasses app
npm --prefix "$ROOT/glasses" run dev -- --port "$APP_PORT" --strictPort --host 127.0.0.1 > "$OUT/logs/vite.log" 2>&1 &
echo $! > "$OUT/pids/vite.pid"
wait_http "http://127.0.0.1:$APP_PORT/" 30 || { echo "vite did not come up (see $OUT/logs/vite.log)" >&2; exit 4; }
stage "vite up"

# 2. simulator (the app takes the server address and the pair code from the URL: ?server=...&pair=...)
URL="http://127.0.0.1:$APP_PORT/?server=http://127.0.0.1:$SERVER_PORT&pair=$PAIR"
node "$SIM_JS" "$URL" --automation-port "$AUTO_PORT" --no-glow > "$OUT/logs/simulator.log" 2>&1 &
echo $! > "$OUT/pids/simulator.pid"
wait_http "http://127.0.0.1:$AUTO_PORT/api/ping" 30 || { echo "simulator did not come up (see $OUT/logs/simulator.log)" >&2; exit 4; }
stage "simulator ping ok"

# 3. move the simulator window to the AI virtual display (try twice, record positions and errors)
pos_get() { osascript -e 'tell application "System Events" to tell process "evenhub-simulator" to get position of window 1' 2>&1 | tr -d ' \n'; }
pos_set() { osascript -e 'tell application "System Events" to tell process "evenhub-simulator" to set position of every window to {3900, 1120}' 2>&1; }
POS_BEFORE=""
for i in $(seq 1 20); do
  POS_BEFORE="$(pos_get)"
  case "$POS_BEFORE" in [0-9-]*,[0-9-]*) break ;; esac
  sleep 0.5
done
ERR1="$(pos_set)"; POS_AFTER1="$(pos_get)"
sleep 1
ERR2="$(pos_set)"; POS_AFTER2="$(pos_get)"
POS_BEFORE="$POS_BEFORE" ERR1="$ERR1" ERR2="$ERR2" POS_AFTER1="$POS_AFTER1" POS_AFTER2="$POS_AFTER2" node -e '
  const e=process.env;
  const ok=e.POS_AFTER2==="3900,1120";
  require("fs").writeFileSync(process.argv[1],JSON.stringify({target:"3900,1120",before:e.POS_BEFORE,attempt1:{error:e.ERR1||null,after:e.POS_AFTER1},attempt2:{error:e.ERR2||null,after:e.POS_AFTER2},movedToTarget:ok},null,2))' "$OUT/window.json"
stage "window moved (see window.json)"

# 4. server (replay = fictional AMA from server/fixtures/questions.json, never touches the network; STT=none so the mic is not used)
S_EPOCH_MS="$(node -e 'console.log(Date.now())')"
QUESTION_SOURCE=replay MERGER=rules STT=none DATA_DIR="$OUT/data" PORT="$SERVER_PORT" REPLAY_SPEED="$SPEED" \
  npm --prefix "$ROOT/server" start > "$OUT/logs/server.log" 2>&1 &
echo $! > "$OUT/pids/server.pid"
wait_http "http://127.0.0.1:$SERVER_PORT/api/health" 30 || { echo "server did not come up (see $OUT/logs/server.log)" >&2; exit 4; }
H_EPOCH_MS="$(node -e 'console.log(Date.now())')"
stage "server health ok (server started at $S_EPOCH_MS; fixture clock starts about when health is first ok)"

# 4b. positive control: while everything runs, each of the three ports must have exactly 1 listener and our simulator binary must exist
{
  echo "{\"whileRunning\":{\"$SERVER_PORT\":$(listeners "$SERVER_PORT"),\"$APP_PORT\":$(listeners "$APP_PORT"),\"$AUTO_PORT\":$(listeners "$AUTO_PORT")},\"simulatorBinariesWithOurUrl\":$(pgrep -fl "sim-darwin-arm64/bin/evenhub-simulator" 2>/dev/null | grep -c "127.0.0.1:$APP_PORT/")}"
} > "$OUT/ports_during.json"
cat "$OUT/ports_during.json"

# 5. capture t0 = first successful /api/health + OFFSET_MS (fixture clock is about +0..1 s behind that point)
START_AT=$(( H_EPOCH_MS + OFFSET_MS ))
node "$HERE/capture.mjs" "$SCRIPT" "$OUT" --start-at "$START_AT" --window-json "$OUT/window.json" --server "http://127.0.0.1:$SERVER_PORT" --pair-file "$OUT/data/pair.json"
RC=$?
echo "capture exit code: $RC"
exit $RC
