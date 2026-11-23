import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { Settings } from './api.ts'

const K_SERVER = 'nextquestion.server'
const K_PAIR = 'nextquestion.pair'

export const DEFAULT_SERVER = 'http://localhost:8788'

/** Settings live in the Even app's storage (browser localStorage is not reliable in that WebView). */
export async function loadSettings(bridge: EvenAppBridge): Promise<Settings> {
  const q = new URLSearchParams(location.search) // handy for the simulator: ?server=...&pair=...
  const server = q.get('server') || (await bridge.getLocalStorage(K_SERVER)) || DEFAULT_SERVER
  const pair = q.get('pair') || (await bridge.getLocalStorage(K_PAIR)) || ''
  return { server, pair }
}

export async function saveSettings(bridge: EvenAppBridge, s: Settings): Promise<void> {
  await bridge.setLocalStorage(K_SERVER, s.server)
  await bridge.setLocalStorage(K_PAIR, s.pair)
}

export interface SettingsUi {
  set(s: Settings): void
  status(text: string, kind?: 'ok' | 'err'): void
}

export interface HostActions {
  save(s: Settings): Promise<void>
  /** Start or end the AMA from the phone. */
  session(action: 'start' | 'end', minutes?: number): Promise<void>
}

/** The phone-side screen: server address, pairing code and two host buttons. Drawn before the bridge is ready. */
export function mountSettings(root: HTMLElement, initial: Settings, actions: HostActions): SettingsUi {
  root.innerHTML = `
    <h1>Next Question <span class="badge">AMA</span></h1>
    <p class="dim">Shows the next audience question on your glasses. Questions come from your own server.</p>
    <label for="server">Server address</label>
    <input id="server" inputmode="url" autocapitalize="off" autocomplete="off" placeholder="http://192.168.0.10:8788" />
    <label for="pair">Pair code (6 digits, shown when the server starts)</label>
    <input id="pair" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="123456" />
    <button id="save">Save</button>
    <h2>Host controls</h2>
    <p class="dim">Same as /ama_start and /ama_end in the group. Starting an AMA posts a line to the group.</p>
    <label for="minutes">Minutes</label>
    <input id="minutes" inputmode="numeric" value="30" />
    <div class="row"><button id="start">Start AMA</button><button id="end" class="alt">End AMA</button></div>
    <div id="status"></div>`
  const server = root.querySelector<HTMLInputElement>('#server')!
  const pair = root.querySelector<HTMLInputElement>('#pair')!
  const minutes = root.querySelector<HTMLInputElement>('#minutes')!
  const status = root.querySelector<HTMLElement>('#status')!
  server.value = initial.server
  pair.value = initial.pair
  const ui: SettingsUi = {
    set(s) {
      server.value = s.server
      pair.value = s.pair
    },
    status(text, kind) {
      status.textContent = text
      status.className = kind ?? ''
    },
  }
  root.querySelector<HTMLButtonElement>('#save')!.addEventListener('click', () => {
    const s = { server: server.value.trim(), pair: pair.value.trim() }
    if (!/^https?:\/\//.test(s.server)) return ui.status('Server address must start with http:// or https://', 'err')
    if (!/^\d{6}$/.test(s.pair)) return ui.status('Pair code is 6 digits', 'err')
    ui.status('Saving...')
    actions.save(s).then(
      () => ui.status('Saved. Connecting...'),
      (e: Error) => ui.status(`Could not save: ${e.message}`, 'err'),
    )
  })
  const host = (action: 'start' | 'end') => () => {
    const m = Number(minutes.value)
    ui.status(action === 'start' ? 'Starting...' : 'Ending...')
    actions.session(action, action === 'start' && Number.isFinite(m) ? m : undefined).then(
      () => ui.status(action === 'start' ? 'The AMA is live.' : 'The AMA has ended.', 'ok'),
      (e: Error) => ui.status(`Not done: ${e.message}`, 'err'),
    )
  }
  root.querySelector<HTMLButtonElement>('#start')!.addEventListener('click', host('start'))
  root.querySelector<HTMLButtonElement>('#end')!.addEventListener('click', host('end'))
  return ui
}
