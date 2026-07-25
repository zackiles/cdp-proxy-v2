/**
 * @module sdk
 * @description Client SDK (§3) — the automator's whole world. `import { chromium }`
 * and get back **stock** Playwright `Browser`/`Context`/`Page` objects already
 * wired through the proxy with your plugin set. The browser sourcing, proxy, and
 * plugin config are invisible. Under the hood: source a browser → register the
 * plugin set for a short-lived session token → `connectOverCDP` with the token on
 * a connect header (§0.1.2) → hand back genuine Playwright objects.
 */

import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium as pwChromium,
  type Page,
} from 'playwright'
import { Config } from './config.ts'
import { Proxy } from './proxy.ts'
import type { Debug } from './debug.ts'
import { stealth } from '../plugins/stealth.ts'
import { PROXY_METHOD_PREFIX, SESSION_TOKEN_HEADER } from './types.ts'
import type { ConfiguredPlugin, IsolationMode } from './types.ts'

export interface LaunchOptions {
  /** Headless (cloud default) or headful for local debugging. */
  headless?: boolean
  /**
   * Per-session plugin set (the primary knob). Defaults to `[stealth()]` — this
   * is a stealthy Playwright, so you get that without asking. Pass your own list
   * to change it, or `[]` for a plain pass-through proxy.
   */
  plugins?: ConfiguredPlugin[]
  /** Isolation granularity for sessions spawned from this browser. */
  isolation?: IsolationMode
  /** Playwright slow-motion (ms) for headful debugging. */
  slowMo?: number
  /**
   * Trace what plugins do with each message. `true` traces everything; a string
   * filters by `source[:methodGlob]`, where source is a plugin name or `proxy`
   * for the transport — e.g. `'myplugin:Runtime.*'`. Same syntax as `CDP_DEBUG`.
   */
  debug?: boolean | string
}

/** An isolated per-site session: its own context, page, and plugin instances. */
export interface Session {
  browser: Browser
  context: BrowserContext
  page: Page
  close(): Promise<void>
}

let sharedProxy: Proxy | undefined
let starting: Promise<Proxy> | undefined

async function ensureConfig(
  overrides?: Partial<{ headless: boolean; debug: string }>,
): Promise<void> {
  if (!Config.hasGlobal) {
    Config.setGlobal(new Config(await Config.create(await Config.env())))
  }
  if (overrides) Config.update(overrides)
}

function ensureProxy(): Promise<Proxy> {
  if (sharedProxy) return Promise.resolve(sharedProxy)
  if (starting) return starting
  starting = (async () => {
    const proxy = new Proxy({ handleSignals: false })
    await proxy.start()
    sharedProxy = proxy
    return proxy
  })()
  return starting
}

async function connect(opts: LaunchOptions): Promise<Browser> {
  await ensureConfig({
    headless: opts.headless ?? true,
    // Leave the env-provided filter alone unless the caller asked for one.
    ...(opts.debug === undefined
      ? {}
      : { debug: opts.debug === true ? '*' : opts.debug || '' }),
  })
  const proxy = await ensureProxy()
  const token = await proxy.register(
    opts.plugins ?? [stealth()],
    opts.isolation,
  )
  return await pwChromium.connectOverCDP(proxy.endpoint, {
    headers: { [SESSION_TOKEN_HEADER]: token },
    slowMo: opts.slowMo,
  })
}

/** The automator-facing entry point, shaped like Playwright's own `chromium`. */
export interface Chromium {
  launch(opts?: LaunchOptions): Promise<Browser>
  session(opts?: LaunchOptions): Promise<Session>
}

export const chromium: Chromium = {
  /** Launch a stealthy, plugin-configured Playwright `Browser` through the proxy. */
  launch(opts: LaunchOptions = {}): Promise<Browser> {
    return connect(opts)
  },

  /** One isolated site session: its own connection, context, page, plugin state. */
  async session(opts: LaunchOptions = {}): Promise<Session> {
    const browser = await connect(opts)
    const context = await browser.newContext()
    const page = await context.newPage()
    return {
      browser,
      context,
      page,
      async close() {
        await context.close().catch(() => {})
        await browser.close().catch(() => {})
      },
    }
  },
}

/** What connection you got, and which browser it landed on. */
export interface Hello {
  connectionId: string
  sessionToken: string
  plugins: string[]
  upstream: string
}

/** The picture `CDP_DEBUG` traces paint, as data a test can assert on. */
export type Snapshot = ReturnType<Debug['snapshot']>

/** Typed access to the reserved `Proxy.*` methods. */
export interface RPC {
  hello(): Promise<Hello>
  debug(): Promise<Snapshot>
  /** Any other `Proxy.*` method, including ones a plugin answers itself. */
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>
}

/**
 * Talk to the proxy (or to a plugin) over a raw Playwright CDP session.
 *
 * Playwright types `CDPSession.send` against the real protocol, so the reserved
 * `Proxy.*` namespace does not typecheck through it. This restores the types
 * rather than making every caller reach for the same cast.
 */
export function rpc(cdp: CDPSession): RPC {
  const send = <T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> => {
    if (!method.startsWith(PROXY_METHOD_PREFIX)) {
      throw new TypeError(
        `rpc() only sends ${PROXY_METHOD_PREFIX}* methods; got "${method}". ` +
          'Use cdp.send() for real CDP methods.',
      )
    }
    return (cdp.send as (
      m: string,
      p?: Record<string, unknown>,
    ) => Promise<T>)(method, params)
  }
  return {
    hello: () => send<Hello>('Proxy.hello'),
    debug: () => send<Snapshot>('Proxy.debug'),
    send,
  }
}

/** Tear down the shared in-process proxy (and its managed browser). */
export async function shutdown(): Promise<void> {
  if (sharedProxy) {
    await sharedProxy.stop()
    sharedProxy = undefined
    starting = undefined
  }
}
