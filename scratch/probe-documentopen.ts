// Throwaway: raw CDP (no proxy, no Playwright). Does document.open() detach the
// target when Runtime.enable was never sent? Mimics our stealth sequence exactly.

const PORT = 9344
const CHROME = Deno.env.get('CHROME_PATH') ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SKIP_OPEN = Deno.env.get('SKIP_OPEN') === '1'
const T0 = Date.now()

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
  stderr: 'piped',
}).spawn()

// Surface renderer crashes / fatal chrome logs.
;(async () => {
  const dec = new TextDecoder()
  for await (const chunk of proc.stderr) {
    const text = dec.decode(chunk)
    if (/crash|FATAL|ERROR:|Check failed/i.test(text)) {
      console.log('[chrome stderr]', text.trim().slice(0, 300))
    }
  }
})()

async function wsUrl(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return (await r.json()).webSocketDebuggerUrl
      await r.body?.cancel()
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('chrome never opened CDP port')
}

const ws = new WebSocket(await wsUrl())
await new Promise((r) => (ws.onopen = () => r(null)))

let nextId = 1
const pending = new Map<number, (m: Record<string, unknown>) => void>()
const listeners: ((m: Record<string, unknown>) => void)[] = []

ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (typeof m.id === 'number') pending.get(m.id)?.(m), pending.delete(m.id)
  else {
    if (m.method === 'Target.attachedToTarget') {
      const ti = m.params.targetInfo
      console.log(`+${Date.now() - T0}ms ATTACH ${ti.type} ${String(ti.url).slice(0, 60)} sid=${m.params.sessionId.slice(0, 8)}`)
    } else if (m.method === 'Target.detachedFromTarget') {
      console.log(`+${Date.now() - T0}ms DETACH sid=${m.params.sessionId.slice(0, 8)}`)
    } else if (/targetCrashed|documentOpened/.test(m.method)) {
      console.log(`+${Date.now() - T0}ms EVT ${m.method}`)
    }
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

function waitEvent(method: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${method}`)), timeoutMs)
    const l = (m: Record<string, unknown>) => {
      if (m.method === method) {
        clearTimeout(t)
        listeners.splice(listeners.indexOf(l), 1)
        resolve(m)
      }
    }
    listeners.push(l)
  })
}

const rand = () => [...Array(12)].map(() => Math.random().toString(36)[2]).join('')

// Derive the main-world context id WITHOUT Runtime.enable (our stealth technique).
async function mainWorld(sessionId: string, frameId: string): Promise<number | undefined> {
  const name = rand()
  let resolve!: (n: number) => void
  const got = new Promise<number>((r) => (resolve = r))
  const l = (m: Record<string, unknown>) => {
    const p = (m.params ?? {}) as Record<string, unknown>
    if (m.method === 'Runtime.bindingCalled' && p.name === name && p.payload === frameId) {
      resolve(p.executionContextId as number)
    }
  }
  listeners.push(l)
  await send('Runtime.addBinding', { name }, sessionId)
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `document.addEventListener('${name}',(e)=>self['${name}'](e.detail.frameId))`,
    runImmediately: true,
  }, sessionId)
  const iso = await send('Page.createIsolatedWorld', { frameId, worldName: name, grantUniveralAccess: true }, sessionId)
  await send('Runtime.evaluate', {
    expression: `document.dispatchEvent(new CustomEvent('${name}',{detail:{frameId:'${frameId}'}}))`,
    contextId: iso.executionContextId,
  }, sessionId)
  const id = await Promise.race([got, new Promise<undefined>((r) => setTimeout(() => r(undefined), 4000))])
  listeners.splice(listeners.indexOf(l), 1)
  return id
}

try {
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  const attached = waitEvent('Target.attachedToTarget')
  await send('Target.createTarget', { url: 'about:blank' })
  const sessionId = ((await attached).params as Record<string, string>).sessionId
  console.log('page session', sessionId)

  // Mimic Playwright's page init, minus Runtime.enable.
  await send('Page.enable', {}, sessionId)
  await send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId)
  await send('Runtime.runIfWaitingForDebugger', {}, sessionId)

  const tree = await send('Page.getFrameTree', {}, sessionId)
  const frameId = tree.frameTree.frame.id
  console.log('main ctx (about:blank) =>', await mainWorld(sessionId, frameId))
  const util1 = await send('Page.createIsolatedWorld', { frameId, worldName: '__playwright_utility_world__', grantUniveralAccess: true }, sessionId)
  console.log('utility ctx (about:blank) =>', util1.executionContextId)

  await send('Page.navigate', { url: 'https://example.com' }, sessionId)
  await waitEvent('Page.frameNavigated')
  await new Promise((r) => setTimeout(r, 800))

  console.log('main ctx (example.com) =>', await mainWorld(sessionId, frameId))
  const util2 = await send('Page.createIsolatedWorld', { frameId, worldName: '__playwright_utility_world__', grantUniveralAccess: true }, sessionId)
  console.log('utility ctx (example.com) =>', util2.executionContextId)

  if (SKIP_OPEN) {
    console.log('--- CONTROL: skipping document.open ---')
  } else {
    console.log('--- now document.open/write/close from the utility world ---')
    const r = await send('Runtime.evaluate', {
      expression: `document.open();document.write('<button id="b">hi</button>');document.close();'wrote'`,
      contextId: util2.executionContextId,
      returnByValue: true,
    }, sessionId)
    console.log('document.open result =>', JSON.stringify(r))
  }

  console.log('--- waiting 8s to see if the target detaches ---')
  await new Promise((r) => setTimeout(r, 8000))

  const targets = await send('Target.getTargets')
  // deno-lint-ignore no-explicit-any
  console.log('targets still alive =>', targets.targetInfos.filter((t: any) => t.type === 'page').length)
  console.log('PROBE DONE (no detach observed above = document.open is fine)')
} catch (err) {
  console.log('PROBE ERROR:', err instanceof Error ? err.message : String(err))
} finally {
  try { ws.close() } catch { /* ignore */ }
  try { proc.kill() } catch { /* ignore */ }
  await proc.status
}
