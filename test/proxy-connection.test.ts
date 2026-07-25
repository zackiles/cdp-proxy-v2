import { assert, assertEquals } from '@std/assert'
import { ProxyConnection } from '../src/proxy-connection.ts'
import { definePlugin } from '../src/plugin.ts'
import type {
  CDPRequest,
  ConfiguredPlugin,
  ConnectionId,
  PluginContext,
} from '../src/types.ts'

interface Harness {
  /** Every message the fake browser received, in order. */
  browserSaw: CDPRequest[]
  /** Every message the client received, in order. */
  clientSaw: Record<string, unknown>[]
  send(msg: Record<string, unknown>): void
  /** Push an unsolicited event from the browser towards the client. */
  pushEvent(evt: Record<string, unknown>): void
  waitForClient(count: number): Promise<void>
  waitForBrowser(count: number): Promise<void>
  close(): Promise<void>
}

async function until(probe: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !probe(); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert(probe(), 'timed out waiting')
}

/** Everything a test needs to vary about the fake browser and the connection. */
interface Options {
  connectionId?: ConnectionId
  /** Share one map between two harnesses to model two clients of one browser. */
  contextOwners?: Map<string, ConnectionId>
  /** Answer a command with a real result instead of the canned `{ of: method }`. */
  reply?: (msg: CDPRequest) => Record<string, unknown> | undefined
  /** Trace filter for this session alone. */
  debug?: string
}

/**
 * Wire a real client socket → ProxyConnection → fake browser socket so the
 * transport's id remapping and plugin isolation can be asserted end to end.
 */
async function harness(
  plugins: ConfiguredPlugin[] = [],
  options: Options = {},
): Promise<Harness> {
  const browserSaw: CDPRequest[] = []
  const clientSaw: Record<string, unknown>[] = []
  let browserSocket: WebSocket | undefined
  let openBrowser!: () => void
  const browserReady = new Promise<void>((r) => (openBrowser = r))

  const browser = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { response, socket } = Deno.upgradeWebSocket(req)
    browserSocket = socket
    socket.onopen = () => openBrowser()
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data) as CDPRequest
      browserSaw.push(msg)
      const reply: Record<string, unknown> = {
        id: msg.id,
        result: options.reply?.(msg) ?? { of: msg.method },
      }
      if (msg.sessionId) reply.sessionId = msg.sessionId
      socket.send(JSON.stringify(reply))
    }
    return response
  })
  const browserPort = (browser.addr as Deno.NetAddr).port

  let connection: ProxyConnection | undefined
  const proxy = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { response, socket } = Deno.upgradeWebSocket(req)
    connection = new ProxyConnection(socket, {
      sessionToken: 'token',
      connectionId: options.connectionId ?? 'conn',
      upstreamWsUrl: `ws://127.0.0.1:${browserPort}/devtools/browser/x`,
      plugins,
      debug: options.debug,
      contextOwners: options.contextOwners,
    })
    return response
  })
  const proxyPort = (proxy.addr as Deno.NetAddr).port

  const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/devtools/browser/x`)
  client.onmessage = (e) => clientSaw.push(JSON.parse(e.data))
  await new Promise<void>((r) => (client.onopen = () => r()))
  await browserReady

  return {
    browserSaw,
    clientSaw,
    send: (msg) => client.send(JSON.stringify(msg)),
    pushEvent: (evt) => browserSocket!.send(JSON.stringify(evt)),
    waitForClient: (count) => until(() => clientSaw.length >= count),
    waitForBrowser: (count) => until(() => browserSaw.length >= count),
    async close() {
      client.close()
      await connection?.close()
      await proxy.shutdown()
      await browser.shutdown()
      // Let the runtime reclaim the closed sockets before the sanitizer runs.
      await new Promise((r) => setTimeout(r, 30))
    },
  }
}

Deno.test('client ids are remapped upstream and restored on the way back', async () => {
  const h = await harness()
  try {
    h.send({ id: 1000, method: 'Browser.getVersion' })
    await h.waitForClient(1)

    assertEquals(h.browserSaw.length, 1)
    assertEquals(h.browserSaw[0].method, 'Browser.getVersion')
    assert(
      h.browserSaw[0].id !== 1000,
      `expected a proxy-owned id upstream, saw ${h.browserSaw[0].id}`,
    )
    assertEquals(h.clientSaw[0].id, 1000, 'client must see its own id back')
    assertEquals(h.clientSaw[0].result, { of: 'Browser.getVersion' })
  } finally {
    await h.close()
  }
})

Deno.test('sessionId is preserved across the remap', async () => {
  const h = await harness()
  try {
    h.send({ id: 5, method: 'Page.enable', sessionId: 'SESSION-A' })
    await h.waitForClient(1)

    assertEquals(h.browserSaw[0].sessionId, 'SESSION-A')
    assertEquals(h.clientSaw[0].sessionId, 'SESSION-A')
    assertEquals(h.clientSaw[0].id, 5)
  } finally {
    await h.close()
  }
})

Deno.test('plugin ctx.send reaches the browser but never leaks to the client', async () => {
  let resolved: unknown
  const plugin = definePlugin({
    name: 'sender',
    setup: (_cfg, ctx: PluginContext) => ({
      async onSessionStart() {
        resolved = await ctx.send('Browser.getVersion')
      },
    }),
  })()

  const h = await harness([plugin])
  try {
    await h.waitForBrowser(1)
    assertEquals(h.browserSaw[0].method, 'Browser.getVersion')

    // Give the transport room to (incorrectly) forward the response.
    await new Promise((r) => setTimeout(r, 60))
    assertEquals(
      h.clientSaw,
      [],
      'plugin traffic must be invisible to the client',
    )
    assertEquals(resolved, { of: 'Browser.getVersion' })
  } finally {
    await h.close()
  }
})

Deno.test('plugin and client id spaces never collide upstream', async () => {
  const plugin = definePlugin({
    name: 'sender',
    setup: (_cfg, ctx: PluginContext) => ({
      onSessionStart: () => void ctx.send('Browser.getVersion'),
    }),
  })()

  const h = await harness([plugin])
  try {
    await h.waitForBrowser(1)
    h.send({ id: 1, method: 'Target.getTargets' })
    h.send({ id: 2, method: 'Target.getTargets' })
    await h.waitForBrowser(3)
    await h.waitForClient(2)

    const ids = h.browserSaw.map((m) => m.id)
    assertEquals(
      new Set(ids).size,
      ids.length,
      `upstream ids must be unique: ${ids}`,
    )
    assertEquals(h.clientSaw.map((m) => m.id).sort(), [1, 2])
  } finally {
    await h.close()
  }
})

Deno.test('a plugin can answer a request without the browser ever seeing it', async () => {
  const plugin = definePlugin({
    name: 'mocker',
    setup: () => ({
      onRequest: (msg) =>
        msg.method === 'Runtime.enable' ? { respond: { mocked: true } } : msg,
    }),
  })()

  const h = await harness([plugin])
  try {
    h.send({ id: 42, method: 'Runtime.enable', sessionId: 'S1' })
    await h.waitForClient(1)

    assertEquals(h.clientSaw[0], {
      id: 42,
      sessionId: 'S1',
      result: { mocked: true },
    })
    assertEquals(
      h.browserSaw.filter((m) => m.method === 'Runtime.enable').length,
      0,
      'the suppressed command must never reach the browser',
    )
  } finally {
    await h.close()
  }
})

Deno.test('one slow target does not stall the others', async () => {
  const plugin = definePlugin({
    name: 'slow',
    setup: () => ({
      onEvent: async (evt) => {
        if (evt.sessionId === 'slow') {
          await new Promise((r) => setTimeout(r, 300))
        }
        return evt
      },
    }),
  })()

  const h = await harness([plugin])
  try {
    h.pushEvent({ method: 'Page.loadEventFired', sessionId: 'slow' })
    h.pushEvent({ method: 'Page.loadEventFired', sessionId: 'quick' })
    await h.waitForClient(2)

    // On one queue for the whole connection the quick page waited out the slow one,
    // so every page's latency was the worst page's latency.
    assertEquals(h.clientSaw.map((m) => m.sessionId), ['quick', 'slow'])
  } finally {
    await h.close()
  }
})

Deno.test('a target never sees traffic before its own attach is handled', async () => {
  const order: string[] = []
  const plugin = definePlugin({
    name: 'ordered',
    setup: (_cfg, ctx) => ({
      onTargetAttached: async () => {
        await new Promise((r) => setTimeout(r, 200))
        order.push('attached')
      },
      onEvent: (evt) => {
        if (evt.method === 'Page.loadEventFired') {
          order.push(`event targets=${ctx.targets.size}`)
        }
        return evt
      },
    }),
  })()

  const h = await harness([plugin])
  try {
    // Browser-level attach, then immediate traffic for the target it announced.
    h.pushEvent({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'S', targetInfo: { targetId: 't', type: 'page' } },
    })
    h.pushEvent({ method: 'Page.loadEventFired', sessionId: 'S' })
    await h.waitForClient(2)

    // Per-session queues must still be seeded from the root queue, or a plugin
    // reading ctx.targets on the first message finds the target missing.
    assertEquals(order, ['attached', 'event targets=1'])
  } finally {
    await h.close()
  }
})

Deno.test('per-target state is dropped with the target, and is per plugin', async () => {
  const counts: string[] = []
  const counter = (name: string) =>
    definePlugin({
      name,
      setup: (_cfg, ctx) => ({
        onEvent(evt) {
          if (evt.method === 'Page.loadEventFired' && evt.sessionId) {
            const state = ctx.state(evt.sessionId, () => ({ seen: 0 }))
            counts.push(`${name}=${++state.seen}`)
          }
          return evt
        },
      }),
    })()

  const h = await harness([counter('a'), counter('b')])
  try {
    const attached = {
      method: 'Target.attachedToTarget',
      params: { sessionId: 'S', targetInfo: { targetId: 't', type: 'page' } },
    }
    h.pushEvent(attached)
    h.pushEvent({ method: 'Page.loadEventFired', sessionId: 'S' })
    h.pushEvent({ method: 'Page.loadEventFired', sessionId: 'S' })
    await until(() => counts.length === 4)

    // The page closes, and a later one is handed the same session id.
    h.pushEvent({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'S' },
    })
    h.pushEvent(attached)
    h.pushEvent({ method: 'Page.loadEventFired', sessionId: 'S' })
    await until(() => counts.length === 6)

    // Each plugin counts on its own, and neither carries the closed page's tally
    // into the new one — which is what hand-pruning on detach forgets to do.
    assertEquals(counts, ['a=1', 'b=1', 'a=2', 'b=2', 'a=1', 'b=1'])
  } finally {
    await h.close()
  }
})

Deno.test('ctx.inject enables Page first, and can be undone', async () => {
  let off!: () => Promise<void>
  const plugin = definePlugin({
    name: 'injector',
    setup: (_cfg, ctx) => ({
      onTargetAttached: async (target) => {
        off = await ctx.inject('globalThis.x = 1', target.sessionId, {
          world: 'private',
        })
      },
    }),
  })()

  const h = await harness([plugin], {
    reply: (msg) =>
      msg.method === 'Page.addScriptToEvaluateOnNewDocument'
        ? { identifier: 'SCRIPT-1' }
        : undefined,
  })
  try {
    h.pushEvent({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'S', targetInfo: { targetId: 't', type: 'page' } },
    })
    await h.waitForBrowser(2)

    // DANGER: without Page enabled on this very session the script is accepted
    // and then never runs, and the world it names is never created.
    assertEquals(h.browserSaw[0].method, 'Page.enable')
    assertEquals(h.browserSaw[0].sessionId, 'S')
    assertEquals(
      h.browserSaw[1].method,
      'Page.addScriptToEvaluateOnNewDocument',
    )
    assertEquals(h.browserSaw[1].params, {
      source: 'globalThis.x = 1',
      worldName: 'private',
      runImmediately: false,
    })

    await off()
    assertEquals(
      h.browserSaw[2].method,
      'Page.removeScriptToEvaluateOnNewDocument',
    )
    assertEquals(h.browserSaw[2].params, { identifier: 'SCRIPT-1' })
    assertEquals(h.clientSaw.map((m) => m.method), ['Target.attachedToTarget'])
  } finally {
    await h.close()
  }
})

Deno.test('a reply names the command it answers, and the client never sees it', async () => {
  const seen: (string | undefined)[] = []
  const filtered: (string | undefined)[] = []
  const watcher = definePlugin({
    name: 'watcher',
    setup: () => ({ onResponse: (msg) => void seen.push(msg.method) }),
  })()
  // A reply carries no method on the wire, so `match` could not filter onResponse
  // at all before the proxy started supplying one.
  const narrow = definePlugin({
    name: 'narrow',
    match: ['Target.*'],
    setup: () => ({ onResponse: (msg) => void filtered.push(msg.method) }),
  })()

  const h = await harness([watcher, narrow])
  try {
    h.send({ id: 1, method: 'Runtime.evaluate' })
    h.send({ id: 2, method: 'Target.getTargets' })
    await h.waitForClient(2)

    assertEquals(seen, ['Runtime.evaluate', 'Target.getTargets'])
    assertEquals(filtered, ['Target.getTargets'])
    assertEquals(h.clientSaw.map((m) => 'method' in m), [false, false])
  } finally {
    await h.close()
  }
})

Deno.test('a refused request never reaches the browser but still answers the client', async () => {
  const plugin = definePlugin({
    name: 'dropper',
    setup: () => ({ onRequest: () => null }),
  })()

  const h = await harness([plugin])
  try {
    h.send({ id: 9, method: 'Runtime.enable' })
    await new Promise((r) => setTimeout(r, 60))

    assertEquals(h.browserSaw, [])
    // Leaving the client unanswered hung it on id 9 until its own timeout, with
    // nothing on the wire to say why.
    assertEquals(h.clientSaw, [{
      id: 9,
      error: {
        code: -32000,
        message: 'Runtime.enable was refused by plugin "dropper"',
      },
    }])
  } finally {
    await h.close()
  }
})

Deno.test('browser events flow to the client and can be rewritten or dropped', async () => {
  const plugin = definePlugin({
    name: 'events',
    setup: () => ({
      onEvent: (evt) => {
        if (evt.method === 'Runtime.bindingCalled') return null
        if (evt.method === 'Page.loadEventFired') {
          return { ...evt, params: { tagged: true } }
        }
        return evt
      },
    }),
  })()

  const h = await harness([plugin])
  try {
    h.pushEvent({ method: 'Runtime.bindingCalled', params: { name: 'secret' } })
    h.pushEvent({ method: 'Page.loadEventFired', params: {} })
    await h.waitForClient(1)
    await new Promise((r) => setTimeout(r, 40))

    assertEquals(h.clientSaw.length, 1, 'the internal event must be swallowed')
    assertEquals(h.clientSaw[0].method, 'Page.loadEventFired')
    assertEquals(h.clientSaw[0].params, { tagged: true })
  } finally {
    await h.close()
  }
})

Deno.test('ctx.emit injects a synthetic event into the client stream', async () => {
  const plugin = definePlugin({
    name: 'emitter',
    setup: (_cfg, ctx: PluginContext) => ({
      onSessionStart() {
        ctx.emit(
          'Runtime.executionContextsCleared',
          {},
          'SESSION-B' as unknown as never,
        )
      },
    }),
  })()

  const h = await harness([plugin])
  try {
    await h.waitForClient(1)
    assertEquals(h.clientSaw[0], {
      method: 'Runtime.executionContextsCleared',
      params: {},
      sessionId: 'SESSION-B',
    })
  } finally {
    await h.close()
  }
})

Deno.test('Proxy.hello is answered locally by the custom RPC surface', async () => {
  const h = await harness()
  try {
    h.send({ id: 3, method: 'Proxy.hello' })
    await h.waitForClient(1)

    const result = h.clientSaw[0].result as Record<string, unknown>
    assertEquals(h.clientSaw[0].id, 3)
    assertEquals(result.connectionId, 'conn')
    assertEquals(result.sessionToken, 'token')
    assertEquals(h.browserSaw, [], 'Proxy.* must not reach the browser')
  } finally {
    await h.close()
  }
})

Deno.test('tracing one session leaves the others alone', async () => {
  const traced = await harness([], { debug: 'stealth:Runtime.*' })
  const quiet = await harness([])
  try {
    traced.send({ id: 1, method: 'Proxy.debug' })
    quiet.send({ id: 1, method: 'Proxy.debug' })
    await traced.waitForClient(1)
    await quiet.waitForClient(1)

    const filters = (saw: Record<string, unknown>[]) =>
      (saw[0].result as { tracing: string[] }).tracing

    // A process-wide filter meant that asking for one session's traces retuned
    // every other session sharing the proxy.
    assertEquals(filters(traced.clientSaw), ['^stealth$:^Runtime\\..*$'])
    assertEquals(filters(quiet.clientSaw), [])
  } finally {
    await traced.close()
    await quiet.close()
  }
})

/**
 * Two connections sharing one fake browser, where A's plugin opens a context of
 * its own. The interesting half is B: Chrome auto-attaches browser-wide, so B is
 * told about A's page and must both hide it and give it up.
 */
async function sharedBrowser(plugins: ConfiguredPlugin[]) {
  const owners = new Map<string, ConnectionId>()
  let next = 0
  const a = await harness(plugins, {
    connectionId: 'A',
    contextOwners: owners,
    reply: (msg) =>
      msg.method === 'Target.createBrowserContext'
        ? { browserContextId: `CTX-${++next}` }
        : undefined,
  })
  const b = await harness([], { connectionId: 'B', contextOwners: owners })
  return { a, b, owners }
}

function attach(context: string, session: string) {
  return {
    method: 'Target.attachedToTarget',
    params: {
      sessionId: session,
      targetInfo: { targetId: 'T1', type: 'page', browserContextId: context },
    },
  }
}

const opener = definePlugin({
  name: 'opener',
  setup: (_cfg, ctx: PluginContext) => ({
    onSessionStart: () => void ctx.send('Target.createBrowserContext'),
  }),
})

Deno.test('a context a plugin opens is claimed against the whole browser', async () => {
  const { a, b, owners } = await sharedBrowser([opener()])
  try {
    await until(() => owners.get('CTX-1') === 'A')

    b.pushEvent(attach('CTX-1', 'S-FOREIGN'))
    await b.waitForBrowser(1)

    assertEquals(
      b.browserSaw[0].method,
      'Target.detachFromTarget',
      'a hidden target must be given up, or its owner hangs for 30s',
    )
    assertEquals(b.browserSaw[0].params?.sessionId, 'S-FOREIGN')

    b.pushEvent({
      method: 'Page.loadEventFired',
      params: {},
      sessionId: 'S-FOREIGN',
    })
    await new Promise((r) => setTimeout(r, 60))
    assertEquals(b.clientSaw, [], 'nothing about a foreign target reaches B')
  } finally {
    await b.close()
    await a.close()
  }
})

Deno.test('disposing a context releases the claim on either path', async () => {
  let plugin!: PluginContext
  const twice = definePlugin({
    name: 'opener',
    setup: (_cfg, ctx: PluginContext) => {
      plugin = ctx
      return {
        async onSessionStart() {
          await ctx.send('Target.createBrowserContext')
          await ctx.send('Target.createBrowserContext')
        },
      }
    },
  })()

  const { a, b, owners } = await sharedBrowser([twice])
  try {
    await until(() =>
      owners.get('CTX-1') === 'A' && owners.get('CTX-2') === 'A'
    )

    await plugin.send('Target.disposeBrowserContext', {
      browserContextId: 'CTX-2',
    })
    assertEquals(owners.has('CTX-2'), false, 'the plugin path must release')

    a.send({
      id: 1,
      method: 'Target.disposeBrowserContext',
      params: { browserContextId: 'CTX-1' },
    })
    await until(() => owners.size === 0)

    b.pushEvent(attach('CTX-1', 'S-RECLAIMED'))
    await b.waitForClient(1)
    assertEquals(b.clientSaw[0].method, 'Target.attachedToTarget')
    assertEquals(b.browserSaw, [], 'an unowned target is not given up')
  } finally {
    await b.close()
    await a.close()
  }
})

Deno.test('a reaped connection gives up the contexts it claimed', async () => {
  const { a, b, owners } = await sharedBrowser([opener()])
  let closed = false
  try {
    await until(() => owners.get('CTX-1') === 'A')

    await a.close()
    closed = true
    assertEquals(
      owners.has('CTX-1'),
      false,
      'Chrome drops the contexts with the socket, so the claims must go too',
    )

    b.pushEvent(attach('CTX-1', 'S-AFTER-REAP'))
    await b.waitForClient(1)
    assertEquals(b.clientSaw[0].method, 'Target.attachedToTarget')
    assertEquals(b.browserSaw, [], 'an unowned target is not given up')
  } finally {
    await b.close()
    if (!closed) await a.close()
  }
})

Deno.test('an unknown Proxy.* method returns a JSON-RPC method-not-found error', async () => {
  const h = await harness()
  try {
    h.send({ id: 4, method: 'Proxy.nope' })
    await h.waitForClient(1)

    const error = h.clientSaw[0].error as Record<string, unknown>
    assertEquals(error.code, -32601)
    assertEquals(h.browserSaw, [])
  } finally {
    await h.close()
  }
})
