#!/usr/bin/env node
// capture.mjs - drive the Even G2 simulator from a script (JSON) and record the glasses screen.
// Node 22, no dependencies. Needs ffmpeg/ffprobe on PATH (or in /opt/homebrew/bin).
//
//   node capture.mjs <script.json> <outDir> [--start-at <epochMs>] [--window-json <file>] [--server <http://127.0.0.1:8788>] [--pair-file <pair.json>]
//
// Next Question addition: action "session_end" POSTs {"action":"end"} to <server>/api/session with "Authorization: Pair <code from --pair-file>".
// (The code is read at send time and is never written to the report.)
//
// Output in <outDir>: frames/frame_00000.png ..., marks/<name>.png, scene.mp4, report.json, console.json
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { checkCaptureOutput, readScene } from './scene-names.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10)
const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null)

// ---------- args ----------
const argv = process.argv.slice(2)
const pos = []
const opt = {}
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i]
  else pos.push(argv[i])
}
if (pos.length < 2) {
  console.error('usage: node capture.mjs <script.json> <outDir> [--start-at <epochMs>] [--window-json <file>]')
  process.exit(2)
}
const scriptPath = path.resolve(pos[0])
const outDir = path.resolve(pos[1])
let script
try {
  script = readScene(scriptPath)
  checkCaptureOutput(outDir, script.marks)
} catch (error) {
  console.error(error.message.replace(/[\r\n]+/g, ' '))
  process.exit(2)
}
const port = script.automationPort ?? 9898
const fps = script.fps ?? 6
const scale = script.scale ?? 1
const { steps, marks, endAt, frameCount: N } = script
const readyTimeoutS = script.readyTimeoutSec ?? 40
const base = `http://127.0.0.1:${port}`

fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true })
fs.mkdirSync(path.join(outDir, 'marks'), { recursive: true })
for (const f of fs.readdirSync(path.join(outDir, 'frames'))) fs.unlinkSync(path.join(outDir, 'frames', f))

// ---------- minimal PNG decoder (8-bit RGBA, non-interlaced) -> number of lit pixels (alpha>0) ----------
function litPixels(png) {
  try {
    let o = 8
    let w = 0, h = 0, bd = 0, ct = 0, il = 0
    const idat = []
    while (o < png.length) {
      const len = png.readUInt32BE(o)
      const type = png.toString('latin1', o + 4, o + 8)
      const data = png.subarray(o + 8, o + 8 + len)
      if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12] }
      else if (type === 'IDAT') idat.push(data)
      else if (type === 'IEND') break
      o += 12 + len
    }
    if (bd !== 8 || ct !== 6 || il !== 0) return null
    const raw = zlib.inflateSync(Buffer.concat(idat))
    const stride = w * 4
    const prev = Buffer.alloc(stride)
    const cur = Buffer.alloc(stride)
    let lit = 0
    let p = 0
    for (let y = 0; y < h; y++) {
      const ft = raw[p++]
      for (let x = 0; x < stride; x++) {
        const v = raw[p++]
        const a = x >= 4 ? cur[x - 4] : 0
        const b = prev[x]
        const c = x >= 4 ? prev[x - 4] : 0
        let r
        if (ft === 0) r = v
        else if (ft === 1) r = v + a
        else if (ft === 2) r = v + b
        else if (ft === 3) r = v + ((a + b) >> 1)
        else {
          const pp = a + b - c
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
        }
        cur[x] = r & 255
      }
      for (let x = 3; x < stride; x += 4) if (cur[x] > 0) lit++
      cur.copy(prev)
    }
    return lit
  } catch {
    return null
  }
}

// ---------- http ----------
async function shot() {
  const t = Date.now()
  const res = await fetch(`${base}/api/screenshot/glasses`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`screenshot HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return { buf, ms: Date.now() - t }
}

async function main() {
  const report = {
    script: scriptPath,
    automationPort: port,
    fps,
    scale,
    plannedFrames: N,
    plannedSeconds: endAt,
    startedAtIso: new Date().toISOString(),
  }
  // 1. ping
  const tPing = Date.now()
  for (;;) {
    try {
      const r = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(1500) })
      if (r.ok && (await r.text()).includes('pong')) break
    } catch {}
    if (Date.now() - tPing > 30000) throw new Error('ping timed out (30 s)')
    await sleep(300)
  }
  report.pingWaitMs = Date.now() - tPing

  // 2. wait until the glasses screen is lit (ping alone does not mean the app drew something)
  const tReady = Date.now()
  let first = null
  while (Date.now() - tReady < readyTimeoutS * 1000) {
    try {
      const s = await shot()
      const lit = litPixels(s.buf)
      if (lit === null ? s.buf.length > 1500 : lit > 0) { first = s.buf; break }
    } catch {}
    await sleep(400)
  }
  report.readyWaitMs = Date.now() - tReady
  if (!first) {
    report.error = `glasses screen stayed empty for ${readyTimeoutS} s`
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
    throw new Error(report.error)
  }

  // 3. optional wait for an agreed start time (so the app's first prompt lands just after t0)
  if (opt['start-at']) {
    const startAt = Number(opt['start-at'])
    report.startAtLateMs = Date.now() - startAt // > 0 means we were already late
    await sleep(startAt - Date.now())
  }
  const t0 = Date.now()
  report.t0Epoch = t0

  // 4. inputs fire on their own timers so a slow screenshot never delays them
  const inputs = []
  const pending = []
  for (const s of steps) {
    if (s.action === 'wait' || s.action === 'end') continue
    pending.push(
      (async () => {
        await sleep(t0 + s.at * 1000 - Date.now())
        const sent = Date.now()
        const rec = { at: s.at, action: s.action, sentAtSec: +((sent - t0) / 1000).toFixed(3) }
        try {
          if (s.action === 'session_end') {
            const code = JSON.parse(fs.readFileSync(opt['pair-file'], 'utf8')).code
            const r2 = await fetch(`${opt.server}/api/session`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Pair ${code}` },
              body: JSON.stringify({ action: 'end' }),
              signal: AbortSignal.timeout(5000),
            })
            rec.status = r2.status
            rec.response = (await r2.text()).slice(0, 120)
            rec.latencyMs = Date.now() - sent
            inputs.push(rec)
            return
          }
          const r = await fetch(`${base}/api/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: s.action }),
            signal: AbortSignal.timeout(5000),
          })
          rec.status = r.status
          rec.response = (await r.text()).slice(0, 200)
        } catch (e) {
          rec.error = String(e.message ?? e)
        }
        rec.latencyMs = Date.now() - sent
        inputs.push(rec)
      })(),
    )
  }

  // 5. fixed-rate capture: one slot per 1/fps; late slots repeat the previous picture
  const frames = [] // {i, hash, dup, failed, ms}
  const failures = []
  const shotMs = []
  let lastBuf = first
  const write = (i, buf, meta) => {
    fs.writeFileSync(path.join(outDir, 'frames', `frame_${String(i).padStart(5, '0')}.png`), buf)
    frames[i] = { i, hash: sha(buf), ...meta }
  }
  let next = 0
  while (next < N) {
    await sleep(t0 + (next * 1000) / fps - Date.now())
    const slot = Math.min(N - 1, Math.max(next, Math.floor(((Date.now() - t0) * fps) / 1000)))
    for (let k = next; k < slot; k++) write(k, lastBuf, { dup: true }) // missed slots
    try {
      const s = await shot()
      shotMs.push(s.ms)
      lastBuf = s.buf
      write(slot, s.buf, { dup: false, ms: s.ms })
    } catch (e) {
      failures.push({ slot, error: String(e.message ?? e) })
      write(slot, lastBuf, { dup: true, failed: true })
    }
    next = slot + 1
  }
  await Promise.all(pending)
  const durationMeasured = (Date.now() - t0) / 1000

  // 6. per-input effect: did the picture change within 1 s after sending?
  for (const r of inputs.sort((a, b) => a.at - b.at)) {
    const slot0 = Math.min(N - 1, Math.floor(r.sentAtSec * fps))
    const before = frames[Math.max(0, slot0 - 1)]?.hash
    const win = frames.slice(slot0, Math.min(N, slot0 + Math.ceil(fps) + 1))
    r.pictureChangedWithin1s = win.some((f) => f.hash !== before)
  }

  // 7. marks and the mp4 (transparent background -> black)
  const vf = (scaleN) =>
    `[1:v][0:v]overlay=format=auto:shortest=1${scaleN > 1 ? `,scale=iw*${scaleN}:ih*${scaleN}:flags=neighbor` : ''},format=yuv420p`
  const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: outDir, encoding: 'utf8', env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin` } })
  const markRecs = []
  for (const m of marks) {
    const idx = Math.min(N - 1, Math.max(0, Math.floor(m.at * fps)))
    const src = path.join('frames', `frame_${String(idx).padStart(5, '0')}.png`)
    const dst = path.join('marks', `${m.name}.png`)
    const r = ff(['-i', src, '-f', 'lavfi', '-i', 'color=c=black:s=576x288', '-filter_complex', vf(scale), '-frames:v', '1', dst])
    markRecs.push({ name: m.name, at: m.at, frame: idx, hash: frames[idx].hash, lit: litPixels(fs.readFileSync(path.join(outDir, src))), file: `marks/${m.name}.png`, ffmpegOk: r.status === 0, ffmpegErr: r.stderr?.slice(0, 200) || undefined })
  }
  const mp4 = path.join(outDir, 'scene.mp4')
  const r = ff([
    '-framerate', String(fps), '-i', path.join('frames', 'frame_%05d.png'),
    '-f', 'lavfi', '-i', `color=c=black:s=576x288:r=${fps}`,
    '-filter_complex', vf(scale),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', '-r', String(fps), '-movflags', '+faststart',
    'scene.mp4',
  ])
  let probe = null
  if (r.status === 0) {
    const p = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,pix_fmt,width,height,r_frame_rate,nb_read_frames:format=duration,size', '-of', 'json', mp4], { encoding: 'utf8', env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin` } })
    try { probe = JSON.parse(p.stdout) } catch {}
  }

  // 8. console log of the simulator (best effort)
  let consoleTotal = null
  try {
    const c = await (await fetch(`${base}/api/console`, { signal: AbortSignal.timeout(3000) })).json()
    fs.writeFileSync(path.join(outDir, 'console.json'), JSON.stringify(c, null, 2))
    consoleTotal = c.total
  } catch {}

  // 9. report
  const changes = []
  frames.forEach((f, i) => { if (i === 0 || f.hash !== frames[i - 1].hash) changes.push({ frame: i, atSec: +(i / fps).toFixed(2), hash: f.hash }) })
  let window = null
  if (opt['window-json'] && fs.existsSync(opt['window-json'])) {
    try { window = JSON.parse(fs.readFileSync(opt['window-json'], 'utf8')) } catch {}
  }
  Object.assign(report, {
    capturedSeconds: +durationMeasured.toFixed(2),
    frames: {
      written: frames.length,
      freshShots: frames.filter((f) => f && !f.dup).length,
      repeated: frames.filter((f) => f?.dup).length,
      failedShots: failures.length,
      uniquePictures: new Set(frames.map((f) => f.hash)).size,
    },
    screenshotMs: { count: shotMs.length, first: shotMs[0] ?? null, mean: shotMs.length ? Math.round(shotMs.reduce((a, b) => a + b, 0) / shotMs.length) : null, p95: pct(shotMs, 0.95), max: shotMs.length ? Math.max(...shotMs) : null },
    slowShotsOver500ms: frames.filter((f) => f && f.ms > 500).map((f) => ({ frame: f.i, atSec: +(f.i / fps).toFixed(2), ms: f.ms })),
    failures,
    inputs,
    pictureChanges: changes,
    marks: markRecs,
    mp4: r.status === 0 ? { file: 'scene.mp4', probe } : { error: r.stderr?.slice(0, 400) },
    simulatorConsoleEntries: consoleTotal,
    window,
  })
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ frames: report.frames, inputs: inputs.map((i) => `${i.action}@${i.sentAtSec}s status=${i.status} changed=${i.pictureChangedWithin1s}`), marks: markRecs.map((m) => m.name), mp4: report.mp4.error ? report.mp4 : probe?.format }, null, 1))
  if (r.status !== 0) process.exit(1)
}

main().catch((e) => {
  console.error('capture failed:', e.message ?? e)
  process.exit(1)
})
