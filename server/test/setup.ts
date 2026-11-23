// Safety net: tests must never reach the network. Only loopback is allowed (for the local HTTP test).
const realFetch = globalThis.fetch
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(input, init)
  throw new Error(`network access blocked in tests: ${u.hostname}`)
}) as typeof fetch
