import {
  AudioInputSource,
  OsEventTypeList,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { Api, ApiError, type ServerState, type Settings } from './api.ts'
import { onBackgroundRestore, setBackgroundState } from './background.ts'
import { buildScreen, toCreate, toRebuild, type Ctx, type Screen } from './screens.ts'
import type { SettingsUi } from './settings.ts'

const MAX_PCM_BYTES = 960_000 // 30 s of 16 kHz 16-bit mono
const MIN_PCM_BYTES = 3_200 // 0.1 s
const CALL_TIMEOUT_MS = 8_000
const GESTURE_GAP_MS = 400 // a swipe can arrive twice; ignore a second one this soon after the first
const CLICK_AFTER_HOLD_MS = 800 // a long press can be followed by a click event; ignore it

export interface App {
  updateSettings(s: Settings): void
  session(action: 'start' | 'end', minutes?: number): Promise<void>
  dispose(): void
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('bridge call timed out')), ms))])
}

export function startApp(bridge: EvenAppBridge, initial: Settings, ui: SettingsUi): App {
  const api = new Api(initial)
  let state: ServerState | null = null
  let online = false
  let flash = ''
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  let created = false
  let last: Screen | null = null
  let stopSub: (() => void) | null = null

  let recording = false
  let chunks: Uint8Array[] = []
  let recBytes = 0
  let lastGestureAt = 0
  let lastHoldEndAt = 0
  let acting = false

  // Everything shown must survive a background trip: the last state is replayed after restore.
  setBackgroundState('nextquestion', () => ({ state: state as unknown as Record<string, unknown> | null, flash }))
  onBackgroundRestore('nextquestion', (saved) => {
    state = (saved.state as ServerState | null) ?? state
    scheduleRender()
  })

  // --- serialized bridge access (concurrent calls can break the BLE link) ---
  let chain: Promise<unknown> = Promise.resolve()
  function enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = chain.then(() => withTimeout(fn(), CALL_TIMEOUT_MS)).catch((e: Error) => {
      console.error('[bridge]', e.message)
      return undefined
    })
    chain = run
    return run as Promise<T | undefined>
  }

  let renderQueued = false
  function scheduleRender(): void {
    if (renderQueued) return
    renderQueued = true
    void enqueue(async () => {
      renderQueued = false
      await render()
    })
  }

  function ctx(): Ctx {
    return { configured: api.configured, online, flash }
  }

  async function render(): Promise<void> {
    const sc = buildScreen(state, ctx())
    if (!created) {
      const r = await bridge.createStartUpPageContainer(toCreate(sc))
      if (r !== 0) {
        console.error('[render] createStartUpPageContainer result', r)
        return
      }
      created = true
      last = sc
      return
    }
    if (last && last.layout === sc.layout && last.kind === sc.kind) {
      // same containers: update only the text that changed (the header text changes every minute), no flicker
      for (let i = 0; i < sc.text.length; i++) {
        const t = sc.text[i]!
        if (last.text[i]?.content === t.content) continue
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: t.containerID, containerName: t.containerName, contentOffset: 0, contentLength: 0, content: t.content }),
        )
      }
      last = sc
      return
    }
    await bridge.rebuildPageContainer(toRebuild(sc))
    last = sc
  }

  function setFlash(msg: string, ms = 2500): void {
    flash = msg
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = msg ? setTimeout(() => setFlash(''), ms) : null
    scheduleRender()
  }

  function accept(s: ServerState): void {
    state = s
    scheduleRender()
  }

  // --- server link ---
  function connect(): void {
    stopSub?.()
    stopSub = null
    if (!api.configured) {
      online = false
      ui.status('Enter the server address and the 6-digit pair code.')
      scheduleRender()
      return
    }
    stopSub = api.subscribe(
      (s) => accept(s),
      (ok) => {
        online = ok
        ui.status(ok ? 'Connected to the server.' : 'Server unreachable. Retrying...', ok ? 'ok' : 'err')
        scheduleRender()
      },
    )
  }

  async function guarded<T>(fn: () => Promise<T>, fail: string): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setFlash('Wrong pair code')
      else if (e instanceof ApiError && e.status === 409) setFlash(e.message.slice(0, 44))
      else setFlash(fail)
      return undefined
    }
  }

  /** One gesture at a time, and not twice in a row. */
  async function act(fn: () => Promise<void>): Promise<void> {
    const now = Date.now()
    if (acting || now - lastGestureAt < GESTURE_GAP_MS) return
    acting = true
    lastGestureAt = now
    try {
      await fn()
    } finally {
      acting = false
    }
  }

  // --- actions ---
  async function answer(): Promise<void> {
    const head = state?.head
    if (state?.mode !== 'question' || !head) return
    const s = await guarded(() => api.answer(head.id), 'Answer failed')
    if (s) accept(s)
  }

  async function skip(): Promise<void> {
    const head = state?.head
    if (state?.mode !== 'question' || !head) return
    const s = await guarded(() => api.skip(head.id), 'Skip failed')
    if (s) accept(s)
  }

  async function back(): Promise<void> {
    if (state?.mode !== 'question' && state?.mode !== 'answered' && state?.mode !== 'empty') return
    const s = await guarded(() => api.back(), 'Nothing to undo')
    if (s) accept(s)
  }

  async function startRecording(): Promise<void> {
    if (recording || state?.mode !== 'question') return
    chunks = []
    recBytes = 0
    recording = true
    const ok = await bridge.audioControl(true, AudioInputSource.Glasses)
    if (!ok) {
      recording = false
      setFlash('Mic unavailable')
      return
    }
    setFlash('Listening... release to send', 30_000)
  }

  async function stopRecording(): Promise<void> {
    if (!recording) return
    recording = false
    lastHoldEndAt = Date.now()
    await bridge.audioControl(false)
    const total = new Uint8Array(recBytes) // concatenated PCM
    let off = 0
    for (const c of chunks) {
      total.set(c, off)
      off += c.length
    }
    chunks = []
    recBytes = 0
    if (total.length < MIN_PCM_BYTES) return setFlash('Too short, hold longer')
    const id = state?.head?.id
    setFlash('Transcribing...', 20_000)
    try {
      const r = await api.voice(total, id)
      accept(r.state)
      setFlash('')
    } catch (e) {
      if (e instanceof ApiError && e.status === 501) setFlash('Voice is off on the server')
      else if (e instanceof ApiError && e.status === 409) setFlash(e.message.slice(0, 44))
      else setFlash('Voice failed')
    }
  }

  function stopHardware(): void {
    if (recording) {
      recording = false
      chunks = []
      void bridge.audioControl(false)
    }
  }

  // --- input ---
  const unsubscribeEvents = bridge.onEvenHubEvent((ev: EvenHubEvent) => {
    if (ev.audioEvent) {
      if (recording) {
        const pcm = new Uint8Array(ev.audioEvent.audioPcm)
        recBytes += pcm.length
        chunks.push(pcm)
        if (recBytes >= MAX_PCM_BYTES) void stopRecording()
      }
      return
    }

    // Long press (9) and its release (10) can surface on any of the three event kinds depending on the focused container.
    const kinds = [ev.listEvent?.eventType, ev.textEvent?.eventType, ev.sysEvent?.eventType]
    if (kinds.includes(OsEventTypeList.LONG_PRESS_EVENT)) return void startRecording()
    if (kinds.includes(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) return void stopRecording()

    if (ev.sysEvent) {
      const t = ev.sysEvent.eventType ?? 0 // a single press arrives as undefined (protobuf drops 0)
      switch (t) {
        case OsEventTypeList.DOUBLE_CLICK_EVENT:
          void bridge.shutDownPageContainer(1) // system exit dialog; cleanup happens on the exit events below
          return
        case OsEventTypeList.FOREGROUND_ENTER_EVENT:
          scheduleRender()
          return
        case OsEventTypeList.FOREGROUND_EXIT_EVENT:
          stopHardware()
          return
        case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        case OsEventTypeList.SYSTEM_EXIT_EVENT:
          dispose()
          return
        case OsEventTypeList.CLICK_EVENT:
          if (recording || Date.now() - lastHoldEndAt < CLICK_AFTER_HOLD_MS) return
          void act(answer)
          return
        default:
          return
      }
    }

    if (ev.textEvent) {
      const t = ev.textEvent.eventType ?? 0
      if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) void act(skip) // swipe down = skip
      else if (t === OsEventTypeList.SCROLL_TOP_EVENT) void act(back) // swipe up = back
    }
  })

  function dispose(): void {
    stopHardware()
    stopSub?.()
    stopSub = null
    unsubscribeEvents()
  }

  scheduleRender()
  connect()

  return {
    updateSettings(s) {
      api.update(s)
      state = null
      connect()
    },
    async session(action, minutes) {
      const s = await api.session(action, minutes)
      accept(s)
    },
    dispose,
  }
}
