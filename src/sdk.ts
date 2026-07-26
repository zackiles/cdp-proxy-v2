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
import { Logger } from './logger.ts'
import type { Debug } from './debug.ts'
import { stealth } from '../plugins/stealth.ts'
import { PROXY_METHOD_PREFIX, SESSION_TOKEN_HEADER } from './types.ts'
import type {
  Constraint,
  Coverage,
  IsolationMode,
  PluginList,
  Profile,
} from './types.ts'

const log = Logger.get('sdk')

export interface LaunchOptions {
  /** Headless (cloud default) or headful for local debugging. */
  headless?: boolean
  /**
   * Per-session plugin set (the primary knob). Defaults to `[stealth()]` — this
   * is a stealthy Playwright, so you get that without asking.
   *
   * Three configurations, one option (§8.6):
   *
   * ```ts
   * chromium.launch()                    // the stealth preset, plus core
   * chromium.launch({ plugins: [] })     // core only
   * chromium.launch({ plugins: 'none' }) // nothing at all — a transparent relay
   * ```
   *
   * An element may be a preset, which expands to several plugins. Core (§8.3) is
   * installed for every value but `'none'`, so `[]` is a session that is not
   * announced on the wire and presents the real machine honestly, with no
   * fingerprint spoofing to get wrong.
   */
  plugins?: PluginList
  /**
   * What to ask the profile loaders for (§2.4).
   *
   * ```ts
   * chromium.launch({ profile: { os: ['Windows'], minChrome: 140 } })
   * ```
   *
   * DANGER: this is a **query**, not an override. A loader returns a whole
   * coherent row that satisfies it, or the next loader tries. There is
   * deliberately no way to change one field of a drawn profile: patching `os` to
   * `'Windows'` on a row drawn from macOS is how a session ends up claiming an
   * Apple GPU under a Windows User-Agent. For a variant, ask for a tighter
   * constraint.
   */
  profile?: Constraint
  /** Isolation granularity for sessions spawned from this browser. */
  isolation?: IsolationMode
  /** Playwright slow-motion (ms) for headful debugging. */
  slowMo?: number
  /**
   * Trace what plugins do with each message, for this session only. `true` traces
   * everything; a string filters by `source[:methodGlob]`, where source is a plugin
   * name or `proxy` for the transport — e.g. `'myplugin:Runtime.*'`. Same syntax as
   * `CDP_DEBUG`, which supplies the default.
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
/** The mode the pool's browsers were actually launched in, for conflict warnings. */
let launched: boolean | undefined

async function ensureConfig(
  overrides?: Partial<{ headless: boolean }>,
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
    launched = Config.get('headless')
    sharedProxy = proxy
    return proxy
  })()
  return starting
}

async function connect(opts: LaunchOptions): Promise<Browser> {
  const headless = opts.headless ?? true
  await ensureConfig({ headless })
  const proxy = await ensureProxy()

  // The pool launched its browsers when the proxy started, so a later change of
  // mind cannot reach them. A browser-isolated session gets a process of its own
  // and does honour it.
  if (
    launched !== undefined && launched !== headless &&
    opts.isolation !== 'browser'
  ) {
    log.warn(
      `headless: ${headless} was ignored — this process already launched its ` +
        `browsers with headless: ${launched}. Pass isolation: 'browser' for a ` +
        'session that needs its own mode, or launch it from its own process.',
    )
  }

  // For one release, since anyone running the proxy as a transparent debugging
  // relay gets a different browser after this change and should find that out
  // from a log line rather than from a detector.
  if (Array.isArray(opts.plugins) && opts.plugins.length === 0) {
    log.warn(
      'plugins: [] now means core-only, not pass-through — the session is not ' +
        "announced on the wire. Pass plugins: 'none' for a transparent relay.",
    )
  }
  if (opts.plugins === 'none') {
    log.warn(
      "plugins: 'none' is a diagnostic, not a supported production mode: the " +
        'browser announces itself on the wire.',
    )
  }

  const token = await proxy.register(
    opts.plugins ?? [stealth()],
    opts.isolation,
    // Leave the env-provided filter alone unless the caller asked for one.
    opts.debug === undefined
      ? undefined
      : opts.debug === true
      ? '*'
      : opts.debug || '',
    opts.profile,
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
  /** Every `Proxy.*` method this session answers, the runtime's and the plugins' (§7.3). */
  rpc: string[]
}

/** The picture `CDP_DEBUG` traces paint, as data a test can assert on. */
export type Snapshot = ReturnType<Debug['snapshot']>

/**
 * The sealed identity and who read what (§2.8). `null` for `plugins: 'none'`,
 * which claims nothing about the machine.
 *
 * `profile` is the row without `noise`, which does not survive the wire; derive
 * jitter from `seed` if a test needs to predict it.
 */
export interface Identity {
  profile: Omit<Profile, 'noise'> | null
  coverage: Coverage | null
}

/** Typed access to the reserved `Proxy.*` methods. */
export interface RPC {
  hello(): Promise<Hello>
  debug(): Promise<Snapshot>
  /** The drawn identity and its coverage report. */
  profile(): Promise<Identity>
  /**
   * Retire this session's identity so no loader hands it out again (§2.7).
   *
   * Only the code driving the page can recognize a block, so this is the
   * automator's call rather than the runtime's. `told` names the loaders that
   * did something about it: `remote` persists the withdrawal, `corpus` drops the
   * row for the life of the process, and `generate` and `pin` have no state to
   * withdraw from, so an empty list means nothing was tracking the row.
   */
  burn(reason: string): Promise<{ burnt: boolean; told: string[] }>
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
    profile: () => send<Identity>('Proxy.profile'),
    burn: (reason) =>
      send<{ burnt: boolean; told: string[] }>('Proxy.burn', { reason }),
    send,
  }
}

/** Tear down the shared in-process proxy (and its managed browser). */
export async function shutdown(): Promise<void> {
  if (sharedProxy) {
    await sharedProxy.stop()
    sharedProxy = undefined
    starting = undefined
    launched = undefined
  }
}
