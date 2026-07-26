/**
 * @module harness
 * @description The testing API (§9.8). Public platform API rather than test-only
 * machinery, because every phase of the platform is defined by what it can
 * assert, and with five kinds leaving authors to assemble a fake CDP stream by
 * hand is how test quality diverges.
 *
 * Two modes, one shape:
 *
 * - **real** drives an actual browser through the actual proxy and hands back a
 *   page handle, so a surface can be asserted from inside the page it patched.
 * - **fake** (`{ fake: true }`) swaps the browser for a scripted CDP stream, for
 *   tests that only need to assert what went out on the wire.
 *
 * Core is installed in both, as it is everywhere else, so a plugin is tested in
 * the configuration it will actually run in. `harness({ plugins: 'none' })` drops
 * it for the rare test that needs the unmodified wire.
 *
 * ```ts
 * await using it = await harness({ plugins: [webgl()] })
 * assertEquals(await it.page.eval(() => navigator.webdriver), false)
 * ```
 */

import type { Browser, Page } from 'playwright'
import type {
  CDPRequest,
  ConfiguredPlugin,
  ConnectionId,
  Constraint,
  Coverage,
  Draw,
  LaunchSpec,
  PageContext,
  PluginList,
  Profile,
  Realm,
} from './types.ts'
import { Config } from './config.ts'
import { ProxyConnection } from './proxy-connection.ts'
import { resolvePlugins } from './proxy.ts'
import { draw, seal } from './profile.ts'
import { PLATFORM, resolve as resolveLaunch } from './launch.ts'

export interface HarnessOptions {
  /** Mirrors `LaunchOptions.plugins`, including `'none'` (§8.6). Core is installed. */
  plugins?: PluginList
  /**
   * What to ask the loaders for (§2.4). A fake harness seeds from `id` when given
   * one, so a test that pins an id gets the same machine on every run.
   */
  profile?: Constraint
  /** Swap the browser for a scripted CDP stream; for assertions on what went out. */
  fake?: boolean
  headless?: boolean
  /** Answer a faked command with a real result instead of `{ of: method }`. */
  reply?: (msg: CDPRequest) => Record<string, unknown> | undefined
  /** Trace filter for this session alone; also fills `trace`. */
  debug?: boolean | string
  connectionId?: ConnectionId
  /** Share one map between two harnesses to model two clients of one browser. */
  contextOwners?: Map<string, ConnectionId>
}

/** A page handle over a real page, matching the subset of §6.2 that exists today. */
export interface HarnessPage extends
  Pick<
    PageContext,
    'url' | 'eval' | 'has' | 'wait' | 'click' | 'fill' | 'goto' | 'log'
  > {
  /** The Playwright page underneath, for assertions the handle does not cover. */
  readonly raw: Page
}

/** What a fake-mode harness lets a test see and do on the wire. */
export interface Wire {
  /** Every message the fake browser received, in order. */
  readonly browserSaw: CDPRequest[]
  /** Every message the client received, in order. */
  readonly clientSaw: Record<string, unknown>[]
  send(msg: Record<string, unknown>): void
  /** Push an unsolicited event from the browser towards the client. */
  pushEvent(evt: Record<string, unknown>): void
  waitForClient(count: number): Promise<void>
  waitForBrowser(count: number): Promise<void>
}

/**
 * One evaluation of the same expression in every realm a surface can claim.
 *
 * Keyed by realm rather than the array §11 sketches, because the entire purpose
 * is finding the realm that disagrees: `assertEquals(seen, { page: 8, iframe: 8,
 * worker: 8, service_worker: 8 })` names the one that got away with the real
 * value, where a positional array leaves the reader counting.
 */
export type RealmReport<T> = Record<Realm, T>

export interface Harness extends AsyncDisposable {
  /** Present in real mode; a fake harness has no browser to open a page on. */
  readonly page: HarnessPage
  /** Present in fake mode. */
  readonly wire: Wire
  readonly browser: Browser
  readonly trace: readonly string[]
  /** The sealed identity, as the session actually resolved it (§2.6). */
  readonly profile: Omit<Profile, 'noise'>
  /** Who read what, and which fields nothing claimed (§2.8). */
  readonly coverage: Coverage
  /**
   * How the process would be started: the merged flags, environment, data dir
   * and the conflicts the merge reported (§3.1).
   *
   * Resolved in both modes — fake mode runs the merge without a process, which
   * is the whole of what a `launch` plugin decides. What the merge cannot show
   * is `onStart`, since nothing started.
   */
  readonly launch: LaunchSpec
  /**
   * Move the page onto a real loopback origin and return it.
   *
   * `about:blank` is not one, and a surprising amount of the platform is gated
   * on having one: `navigator.mediaDevices`, `getBattery`, service workers and
   * blob workers are all absent or refused without a secure context, so a
   * surface tested on the blank page reports as standing down when it works.
   */
  origin(): Promise<string>
  /**
   * Run one expression in the page, an iframe, and a worker — how a surface
   * proves the `realms` it claims (§4.4).
   *
   * DANGER: the expression is serialized the same way a `page` function is, so
   * it closes over nothing. A variable from the test body is `undefined` inside
   * it, with no error.
   */
  eachRealm<T>(fn: () => T): Promise<RealmReport<T>>
}

async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300 && !probe(); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
}

/** Run `close` and resolve once the socket has actually reached CLOSED. */
function closed(socket: WebSocket, close: () => void): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise<void>((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true })
    socket.addEventListener('error', () => resolve(), { once: true })
    close()
  })
}

/**
 * Run the `launch` merge without starting anything (§3.1).
 *
 * A launch plugin decides one thing — what the command line and environment say
 * — and it decides it before any process exists. That makes it the one kind a
 * harness can resolve completely without a browser, which is why fake mode gets
 * the same `launch` a real session would have had.
 */
function launched(
  plugins: ConfiguredPlugin[],
  drawn: Draw | undefined,
): Promise<LaunchSpec> {
  if (plugins.length === 0 || !drawn) {
    return Promise.resolve({
      flags: [],
      env: {},
      extensions: [],
      conflicts: [],
    })
  }
  const sealed = seal(drawn)
  return resolveLaunch(plugins, (plugin) => ({
    profile: sealed,
    platform: PLATFORM,
    signal: new AbortController().signal,
    log: (...args: unknown[]) => console.debug(`[${plugin}]`, ...args),
  })).then((resolved) => resolved.spec)
}

/**
 * Wire a real client socket → {@link ProxyConnection} → fake browser socket, so
 * the transport's id remapping, plugin ordering, and everything a plugin sends
 * can be asserted without a browser.
 */
async function fake(opts: HarnessOptions): Promise<Harness> {
  const browserSaw: CDPRequest[] = []
  const clientSaw: Record<string, unknown>[] = []
  let browserSocket: WebSocket | undefined
  let openBrowser!: () => void
  const browserReady = new Promise<void>((r) => (openBrowser = r))

  const upstream = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { response, socket } = Deno.upgradeWebSocket(req)
    browserSocket = socket
    socket.onopen = () => openBrowser()
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data) as CDPRequest
      browserSaw.push(msg)
      const reply: Record<string, unknown> = {
        id: msg.id,
        result: opts.reply?.(msg) ?? { of: msg.method },
      }
      if (msg.sessionId) reply.sessionId = msg.sessionId
      socket.send(JSON.stringify(reply))
    }
    return response
  })
  const upstreamPort = (upstream.addr as Deno.NetAddr).port

  const set = resolvePlugins(opts.plugins ?? [])
  const profile = set.profile.length > 0
    ? await draw(set.profile, opts.profile ?? {}, opts.profile?.id ?? 'harness')
    : undefined
  const spec = await launched(set.launch, profile)

  let connection: ProxyConnection | undefined
  const front = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { response, socket } = Deno.upgradeWebSocket(req)
    connection = new ProxyConnection(socket, {
      sessionToken: 'harness',
      connectionId: opts.connectionId ?? 'harness',
      upstreamWsUrl: `ws://127.0.0.1:${upstreamPort}/devtools/browser/x`,
      plugins: set.protocol,
      surfaces: set.surface,
      profile,
      debug: opts.debug === true ? '*' : opts.debug || undefined,
      contextOwners: opts.contextOwners,
    })
    return response
  })
  const frontPort = (front.addr as Deno.NetAddr).port

  const client = new WebSocket(`ws://127.0.0.1:${frontPort}/devtools/browser/x`)
  client.onmessage = (e) => clientSaw.push(JSON.parse(e.data))
  await new Promise<void>((r) => (client.onopen = () => r()))
  await browserReady

  return {
    get page(): HarnessPage {
      throw new Error('harness.page is not available in fake mode')
    },
    get browser(): Browser {
      throw new Error('harness.browser is not available in fake mode')
    },
    get profile(): Omit<Profile, 'noise'> {
      if (!profile) throw new Error('this harness has no profile loaders')
      return profile
    },
    get coverage(): Coverage {
      throw new Error('harness.coverage needs a real session; drop { fake }')
    },
    launch: spec,
    eachRealm(): never {
      throw new Error('harness.eachRealm needs a real page; drop { fake }')
    },
    origin(): never {
      throw new Error('harness.origin needs a real page; drop { fake }')
    },
    trace: [],
    wire: {
      browserSaw,
      clientSaw,
      send: (msg) => client.send(JSON.stringify(msg)),
      pushEvent: (evt) => browserSocket!.send(JSON.stringify(evt)),
      waitForClient: (count) =>
        until(() => clientSaw.length >= count, `${count} client messages`),
      waitForBrowser: (count) =>
        until(() => browserSaw.length >= count, `${count} browser messages`),
    },
    async [Symbol.asyncDispose]() {
      // Every socket is awaited to `closed` rather than merely asked to close.
      // `WebSocket.close()` returns before the close handshake finishes, so a
      // test that opened a harness and asserted nothing would hand a still-open
      // socket to the leak sanitizer and fail on the next test's behalf.
      await closed(client, () => client.close())
      await connection?.close()
      if (browserSocket) {
        await closed(browserSocket, () => browserSocket!.close())
      }
      await front.shutdown()
      await upstream.shutdown()
    },
  }
}

/**
 * A loopback origin for `eachRealm`, started on first use and shut down with the
 * harness.
 *
 * DANGER: the fixture exists because `about:blank` is not an origin, and three
 * of the four realms need one. An `about:blank` iframe never fires `load`, a
 * blob worker from a null origin is refused by CORS, and a service worker cannot
 * be registered at all. A harness page left on `about:blank` therefore reports
 * a surface as working in every realm it could not reach, which is the exact
 * wrong answer.
 */
function fixture(): { origin: string; stop: () => Promise<void> } {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { pathname } = new URL(req.url)
    if (pathname === '/sw.js') {
      // Generic rather than per-probe: a service worker registration is
      // expensive and cached, so the worker takes the expression as a message
      // instead of being re-registered for every assertion.
      return new Response(
        `self.addEventListener('message', async (e) => {\n` +
          `  try { e.source.postMessage(await eval('(' + e.data + ')')()) }\n` +
          `  catch (err) { e.source.postMessage({ __error: String(err) }) }\n` +
          `})\n` +
          `self.addEventListener('install', () => self.skipWaiting())\n` +
          `self.addEventListener('activate', (e) => e.waitUntil(clients.claim()))`,
        { headers: { 'content-type': 'text/javascript' } },
      )
    }
    return new Response('<!doctype html><title>harness</title>', {
      headers: { 'content-type': 'text/html' },
    })
  })
  return {
    origin: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
    stop: () => server.shutdown(),
  }
}

/**
 * Evaluate one expression in an iframe, a dedicated worker, and a service worker
 * of an open page.
 *
 * Every realm is created from inside the page rather than by the harness, which
 * is the point: a same-origin iframe and a worker are exactly what a page
 * reaches for to get an unpatched copy of an API, so a surface that survives
 * this survives the bypass it is being tested against (§7.1).
 */
async function elsewhere<T>(
  page: Page,
  source: string,
): Promise<Omit<RealmReport<T>, 'page'>> {
  const iframe = await page.evaluate(async (fn) => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const inner = frame.contentWindow as Window & {
      eval(code: string): unknown
    }
    // IMPORTANT: do not wait for `load` here. An `about:blank` iframe reaches
    // its initial document during insertion, so the event has already fired by
    // the time a listener could be attached and the wait never returns. The
    // frame is usable on the line after `append`.
    //
    // `contentWindow.eval` rather than the parent's, so the expression sees the
    // frame's own globals — evaluating in the parent would test nothing.
    const value = await inner.eval(`(${fn})()`)
    frame.remove()
    return value as unknown
  }, source)

  const worker = await page.evaluate(async (fn) => {
    const url = URL.createObjectURL(
      new Blob([`onmessage = async () => postMessage(await (${fn})())`], {
        type: 'text/javascript',
      }),
    )
    const w = new Worker(url)
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the worker never answered')),
          15_000,
        )
        w.onmessage = (e) => (clearTimeout(timer), resolve(e.data))
        w.onerror = (e) => (clearTimeout(timer), reject(new Error(e.message)))
        w.postMessage(null)
      })
    } finally {
      w.terminate()
      URL.revokeObjectURL(url)
    }
  }, source)

  const service_worker = await page.evaluate(async (fn) => {
    const registration = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    const active = registration.active ?? navigator.serviceWorker.controller
    if (!active) throw new Error('the service worker never activated')
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the service worker never answered')),
        15_000,
      )
      navigator.serviceWorker.addEventListener('message', (e) => {
        clearTimeout(timer)
        const failed = (e.data as { __error?: string })?.__error
        failed ? reject(new Error(failed)) : resolve(e.data)
      }, { once: true })
      active.postMessage(fn)
    })
  }, source)

  return {
    iframe: iframe as T,
    worker: worker as T,
    service_worker: service_worker as T,
  }
}

/** A real browser through the real proxy, with a page already open. */
async function live(opts: HarnessOptions): Promise<Harness> {
  // Imported lazily so a fake-mode test never pulls in Playwright or the pool.
  const { chromium, rpc } = await import('./sdk.ts')
  const browser = await chromium.launch({
    plugins: opts.plugins ?? [],
    profile: opts.profile,
    headless: opts.headless ?? true,
    isolation: 'browser',
    debug: opts.debug,
  })
  const page = await browser.newPage()
  const control = rpc(await page.context().newCDPSession(page))
  const identity = await control.profile()
  // Asked of the session rather than resolved a second time here: the process is
  // already running, and a merge run twice can only ever disagree with the one
  // the browser was actually started from.
  const { launch } = await control.debug()
  let served: ReturnType<typeof fixture> | undefined

  const origin = async () => {
    served ??= fixture()
    if (!page.url().startsWith(served.origin)) {
      await page.goto(served.origin, { waitUntil: 'domcontentloaded' })
    }
    return served.origin
  }

  const handle: HarnessPage = {
    raw: page,
    get url() {
      return page.url()
    },
    eval:
      (<T, A>(fn: (arg: A) => T, arg?: A) =>
        page.evaluate(fn as (a: unknown) => T, arg)) as HarnessPage['eval'],
    has: async (selector) => (await page.locator(selector).count()) > 0,
    wait: (selector, timeout = 5_000) =>
      page.locator(selector).first().waitFor({ state: 'attached', timeout })
        .then(() => true, () => false),
    click: (selector) => page.click(selector),
    fill: (selector, text) => page.fill(selector, text),
    goto: async (url) => void await page.goto(url),
    log: (...args) => console.debug('[harness]', ...args),
  }

  return {
    page: handle,
    browser,
    trace: [],
    get profile(): Omit<Profile, 'noise'> {
      if (!identity.profile) {
        throw new Error("this session claims no identity (plugins: 'none')")
      }
      return identity.profile
    },
    get coverage(): Coverage {
      if (!identity.coverage) {
        throw new Error("this session claims no identity (plugins: 'none')")
      }
      return identity.coverage
    },
    launch,
    origin,
    async eachRealm<T>(fn: () => T): Promise<RealmReport<T>> {
      await origin()
      return {
        page: await page.evaluate(fn),
        ...await elsewhere<T>(page, fn.toString()),
      }
    },
    get wire(): Wire {
      throw new Error('harness.wire is only available in fake mode')
    },
    async [Symbol.asyncDispose]() {
      await browser.close().catch(() => {})
      await served?.stop()
    },
  }
}

export function harness(opts: HarnessOptions = {}): Promise<Harness> {
  if (opts.fake) return fake(opts)
  if (!Config.hasGlobal) {
    // The pool would otherwise throw from deep inside `start()`, long after the
    // call that actually forgot to configure anything.
    return Promise.reject(
      new Error(
        'harness() in real mode needs a global Config; call ' +
          'Config.setGlobal(new Config(await Config.create(...))) first, or ' +
          'pass { fake: true }',
      ),
    )
  }
  return live(opts)
}
