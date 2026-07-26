import { getAvailablePort } from '@std/net'
import * as dotenv from '@std/dotenv'
import type { EnvVars } from './types.ts'
import {
  PROXY_TO_CDP_LOG_LEVEL,
  PROXY_TO_LAUNCHER_LOG_LEVEL,
} from './constants.ts'
import type { LogLevelName } from './logger.ts'

type ChromeLauncherLogLevel = 'silent' | 'error' | 'warn' | 'info' | 'verbose'

export type ConfigOptions = {
  proxyPort: number
  proxyHost: string
  browserPort: number
  browserHost: string
  browserDirectory: string
  browserVersion: string
  browserExecutablePath: string
  /** A preconfigured/remote CDP endpoint to front instead of launching locally. */
  browserWsEndpoint: string
  /** Launch the managed browser headless (cloud default) or headful (local debug). */
  headless: boolean
  /** Default isolation granularity for sessions. */
  isolation: 'context' | 'browser'
  /** Directory of plugins to expose by name over the control endpoint; '' disables. */
  pluginsDirectory: string
  /** Plugin trace filter, e.g. `1`, `stealth`, `stealth:Runtime.*`; '' disables. */
  debug: string
  /**
   * Pin every session to one identity, by id (§2.3). The id is the seed, so the
   * same value re-draws the same machine — which is how a failure is re-opened
   * tomorrow on the machine it failed on. '' draws fresh.
   */
  profile: string
  /**
   * How many identities the fleet has. Defaults to the pool size — one per slot,
   * so the default never correlates two sessions that did not ask to be
   * correlated (§2.7).
   */
  profiles: number
  /** Path to a JSONL corpus of captured fingerprints; '' uses `generate`. */
  corpus: string
  proxyLogLevel:
    | 'silent'
    | 'error'
    | 'warn'
    | 'info'
    | 'debug'
    | 'log'
    | 'verbose'
  proxyLogTags: string
  launcherLogLevel: ChromeLauncherLogLevel
  cdpLogLevelFlag: string
}

/** Relative paths to the browser binary inside a Playwright `chromium-*` build. */
const BROWSER_BINARIES = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-linux/chrome',
  'chrome-win/chrome.exe',
]

/**
 * Find the newest "Chrome for Testing" from Playwright's browser cache.
 *
 * DANGER: do not default to `/Applications/Google Chrome.app` on managed macOS
 * fleets. It inherits `com.google.Chrome` managed preferences, and fresh-profile
 * policy provisioning (forced extension installs) makes the browser detach every
 * page target a few seconds after launch, killing automation mid-run. Chrome for
 * Testing ships a different bundle id, so those policies never apply to it.
 */
async function findBrowser(): Promise<string> {
  const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE')
  if (!home) return ''

  const builds: { build: number; dir: string }[] = []
  for (
    const root of [
      `${home}/Library/Caches/ms-playwright`,
      `${home}/.cache/ms-playwright`,
      `${home}/AppData/Local/ms-playwright`,
    ]
  ) {
    try {
      for await (const entry of Deno.readDir(root)) {
        const build = Number(entry.name.match(/^chromium-(\d+)$/)?.[1])
        if (build) builds.push({ build, dir: `${root}/${entry.name}` })
      }
    } catch { /* cache root absent on this platform */ }
  }

  for (const { dir } of builds.sort((a, b) => b.build - a.build)) {
    for (const binary of BROWSER_BINARIES) {
      const path = `${dir}/${binary}`
      try {
        if ((await Deno.stat(path)).isFile) return path
      } catch { /* try the next layout */ }
    }
  }
  return ''
}

class Config {
  private static _instance: Config | null = null
  private options: ConfigOptions

  constructor(options: ConfigOptions) {
    this.options = { ...options }
  }

  /**
   * Sets the global singleton instance
   * @internal This should only be called once during app initialization
   */
  static setGlobal(config: Config) {
    if (!Config._instance) {
      Config._instance = config
    } else {
      throw new Error('Global Config instance is already set')
    }
  }

  /** Whether a global instance exists, so callers need not catch to find out. */
  static get hasGlobal(): boolean {
    return Config._instance !== null
  }

  /**
   * Gets a configuration value
   * @throws {Error} If global config instance has not been set
   */
  static get<T extends keyof ConfigOptions>(key: T): ConfigOptions[T] {
    if (!Config._instance) {
      throw new Error('Global Config instance has not been set')
    }
    return Config._instance.options[key]
  }

  /**
   * Updates configuration values
   * @throws {Error} If global config instance has not been set
   */
  static update(newOptions: Partial<ConfigOptions>): void {
    if (!Config._instance) {
      throw new Error('Global Config instance has not been set')
    }
    Config._instance.update(newOptions)
  }

  /**
   * @internal For internal use and testing only
   */
  static get instance(): Config {
    if (!Config._instance) {
      throw new Error('Global Config instance has not been set')
    }
    return Config._instance
  }

  get<T extends keyof ConfigOptions>(key: T): ConfigOptions[T] {
    return this.options[key]
  }

  update(newOptions: Partial<ConfigOptions>) {
    Object.assign(this.options, newOptions)
  }

  /**
   * Environment for {@link Config.create}: `.env` supplies defaults and the real
   * process environment overrides them, so containers and CI can configure the
   * proxy without editing a file.
   */
  static async env(): Promise<EnvVars> {
    const file = await dotenv.load({ export: false }).catch(() => ({}))
    return { ...file, ...Deno.env.toObject() } as EnvVars
  }

  static async create(env: EnvVars = {}): Promise<ConfigOptions> {
    const proxyLogLevel =
      (env.CDP_PROXY_LOG_LEVEL as ConfigOptions['proxyLogLevel']) || 'verbose'

    return {
      proxyPort: Number(env.CDP_PROXY_PORT) || (await getAvailablePort()),
      proxyHost: env.CDP_PROXY_HOST || 'localhost',
      browserPort: Number(env.CDP_BROWSER_PORT) || (await getAvailablePort()),
      browserHost: env.CDP_BROWSER_HOST || 'localhost',
      browserDirectory: env.CDP_BROWSER_DIRECTORY || '.cache',
      browserVersion: env.CDP_BROWSER_VERSION || '',
      browserExecutablePath: env.CDP_BROWSER_EXECUTABLE_PATH ||
        (await findBrowser()),
      browserWsEndpoint: env.CDP_BROWSER_WS_ENDPOINT || '',
      headless: String(env.CDP_HEADLESS ?? 'true') !== 'false',
      isolation: String(env.CDP_ISOLATION) === 'browser'
        ? 'browser'
        : 'context',
      // Off unless asked for: importing arbitrary files is the standalone
      // server's job, not something an embedded SDK should do behind your back.
      pluginsDirectory: env.CDP_PLUGINS_DIRECTORY || '',
      debug: env.CDP_DEBUG || '',
      profile: env.CDP_PROFILE || '',
      profiles: Number(env.CDP_PROFILES) || 0,
      corpus: env.CDP_CORPUS || '',
      proxyLogLevel,
      proxyLogTags: env.CDP_PROXY_LOG_TAGS || '',
      // Derived values that don't come from env
      launcherLogLevel:
        PROXY_TO_LAUNCHER_LOG_LEVEL[proxyLogLevel as LogLevelName] || 'verbose',
      cdpLogLevelFlag: PROXY_TO_CDP_LOG_LEVEL[proxyLogLevel as LogLevelName] ||
        PROXY_TO_CDP_LOG_LEVEL.verbose,
    }
  }
}

export { Config }
