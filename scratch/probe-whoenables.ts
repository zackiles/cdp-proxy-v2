// Throwaway: which CDP call flips the Runtime domain on? Raw CDP, no proxy.
// After each step we run the toString trap in the page's main world.
import { Config } from '../src/config.ts'

const PORT = 9377
const CHROME = (await Config.create({})).browserExecutablePath

const proc = new Deno.Command(CHROME, {
  args: [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${await Deno.makeTempDir()}`,
  ],
  stdout: 'null',
  stderr: 'null',
}).spawn()

async function wsUrl(): Promise<string> {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return (await r.json()).webSocketDebuggerUrl
      await r.body?.cancel()
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no CDP port')
}

const ws = new WebSocket(await wsUrl())
await new Promise((r) => (ws.onopen = () => r(null)))

let nextId = 1
const pending = new Map<number, (m: Record<string, unknown>) => void>()
const listeners: ((m: Record<string, unknown>) => void)[] = []
let sawConsoleApi = false

ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (typeof m.id === 'number') pending.get(m.id)?.(m), pending.delete(m.id)
  else {
    if (m.method === 'Runtime.consoleAPICalled') sawConsoleApi = true
    for (const l of listeners) l(m)
  }
}

// deno-lint-ignore no-explicit-any
function send(method: string, params?: unknown, sessionId?: string): Promise<any> {
  const id = nextId++
  const msg: Record<string, unknown> = { id, method, params: params ?? {} }
  if (sessionId) msg.sessionId = sessionId
  ws.send(JSON.stringify(msg))
  return new Promise((resolve, reject) => {
    pending.set(id, (m) =>
      m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result)
    )
  })
}

function waitEvent(method: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const l = (m: Record<string, unknown>) => {
      if (m.method === method) {
        listeners.splice(listeners.indexOf(l), 1)
        resolve(m)
      }
    }
    listeners.push(l)
  })
}

/** Candidate page-visible detectors of an enabled Runtime domain. */
const DETECTORS: Record<string, string> = {
  'own stack getter': `
    const e = new Error('p')
    Object.defineProperty(e, 'stack', { configurable: true, get: () => { fired = true; return '' } })
    console.debug(e)`,
  'Error.prototype.stack accessor': `
    Object.defineProperty(Error.prototype, 'stack', { configurable: true, get: () => { fired = true; return '' } })
    console.debug(new Error('p'))`,
  'error toString': `
    const e = new Error('p')
    e.toString = () => { fired = true; return 'p' }
    console.debug(e)`,
  'plain object getter': `
    console.debug({ get probe() { fired = true; return 1 } })`,
  'proxy ownKeys trap': `
    console.debug(new Proxy({ a: 1 }, { ownKeys(t) { fired = true; return Reflect.ownKeys(t) } }))`,
  'proxy get trap': `
    console.debug(new Proxy({ a: 1 }, { get(t, k) { fired = true; return Reflect.get(t, k) } }))`,
  'array length getter': `
    const a = []
    Object.defineProperty(a, 'probe', { enumerable: true, get: () => { fired = true; return 1 } })
    console.debug(a)`,
}

async function detect(sessionId: string, label: string): Promise<void> {
  const results: string[] = []
  for (const [name, body] of Object.entries(DETECTORS)) {
    sawConsoleApi = false
    const r = await send('Runtime.evaluate', {
      expression:
        `(async () => { let fired = false; ${body}; await new Promise(r => setTimeout(r, 60)); return fired })()`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId)
    if (r.result?.value) results.push(name)
  }
  console.log(`[${label}]`)
  console.log(`   consoleAPICalled reaching us: ${sawConsoleApi}`)
  console.log(`   detectors that fired: ${results.length ? results.join(', ') : '(none)'}`)
}

const trap = detect

try {
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  const attached = waitEvent('Target.attachedToTarget')
  await send('Target.createTarget', { url: 'about:blank' })
  const sessionId = ((await attached).params as Record<string, string>).sessionId

  await send('Runtime.runIfWaitingForDebugger', {}, sessionId)
  await trap(sessionId, 'nothing (baseline)')

  await send('Page.enable', {}, sessionId)
  await send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId)
  await send('Runtime.addBinding', { name: '__probe_binding' }, sessionId)
  const tree = await send('Page.getFrameTree', {}, sessionId)
  await send('Page.createIsolatedWorld', {
    frameId: tree.frameTree.frame.id,
    worldName: '__probe_world',
    grantUniveralAccess: true,
  }, sessionId)
  await trap(sessionId, 'full stealth sequence, Runtime never enabled')

  await send('Runtime.enable', {}, sessionId)
  await trap(sessionId, 'Runtime.enable (positive control)')

  await send('Runtime.disable', {}, sessionId)
  await trap(sessionId, 'Runtime.disable')
} catch (err) {
  console.log('PROBE ERROR:', err instanceof Error ? err.message : String(err))
} finally {
  try { ws.close() } catch { /* ignore */ }
  try { proc.kill() } catch { /* ignore */ }
  await proc.status
}
