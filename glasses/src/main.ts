import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { startApp } from './app.ts'
import { DEFAULT_SERVER, loadSettings, mountSettings, saveSettings } from './settings.ts'

const root = document.getElementById('app')!
let app: ReturnType<typeof startApp> | null = null
let bridgeRef: Awaited<ReturnType<typeof waitForEvenAppBridge>> | null = null

// Draw the phone-side settings first: it must show even while the bridge is still connecting.
const ui = mountSettings(
  root,
  { server: DEFAULT_SERVER, pair: '' },
  {
    async save(s) {
      if (!bridgeRef) throw new Error('Even app bridge is not ready yet')
      await saveSettings(bridgeRef, s)
      app?.updateSettings(s)
    },
    async session(action, minutes) {
      if (!app) throw new Error('Not connected yet')
      await app.session(action, minutes)
    },
  },
)
ui.status('Connecting to the Even app...')

const bridge = await waitForEvenAppBridge()
bridgeRef = bridge
const settings = await loadSettings(bridge)
ui.set(settings)
app = startApp(bridge, settings, ui)
