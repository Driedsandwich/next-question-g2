/**
 * Background state persistence.
 * The background-state guide names setBackgroundState / onBackgroundRestore, but @evenrealities/even_hub_sdk 0.0.16
 * does not export them (checked: no match in dist/). The same guide describes the host contract instead:
 * the host calls window.__getStateSnapshot() before going to background and window.__restoreState(snapshot)
 * in the new WebView. This file implements that contract with the same two-function shape, so it can be swapped
 * for the SDK functions when a later SDK exports them. Not yet checked against a real host.
 */
type Exporter = () => Record<string, unknown>
type Restorer = (saved: Record<string, unknown>) => void

const exporters = new Map<string, Exporter>()
const restorers = new Map<string, Restorer>()

export function setBackgroundState(key: string, exporter: Exporter): void {
  exporters.set(key, exporter)
}

export function onBackgroundRestore(key: string, restorer: Restorer): void {
  restorers.set(key, restorer)
}

declare global {
  interface Window {
    __getStateSnapshot?: () => string
    __restoreState?: (snapshot: unknown) => void
  }
}

window.__getStateSnapshot = () => {
  const out: Record<string, unknown> = {}
  for (const [k, fn] of exporters) {
    try {
      out[k] = fn()
    } catch {
      // a broken exporter must not block the others
    }
  }
  return JSON.stringify(out)
}

window.__restoreState = (snapshot) => {
  let obj: Record<string, unknown> = {}
  try {
    obj = typeof snapshot === 'string' ? JSON.parse(snapshot) : ((snapshot as Record<string, unknown>) ?? {})
  } catch {
    return
  }
  for (const [k, fn] of restorers) {
    const v = obj[k]
    if (v && typeof v === 'object') fn(v as Record<string, unknown>)
  }
}
