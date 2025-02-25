import { getAvailablePort } from '@std/net'
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
      browserExecutablePath: env.CDP_BROWSER_EXECUTABLE_PATH || '',
      proxyLogLevel,
      proxyLogTags: env.CDP_PROXY_LOG_TAGS || '',
      // Derived values that don't come from env
      launcherLogLevel:
        PROXY_TO_LAUNCHER_LOG_LEVEL[proxyLogLevel as LogLevelName] || 'verbose',
      cdpLogLevelFlag:
        PROXY_TO_CDP_LOG_LEVEL[proxyLogLevel as LogLevelName] ||
        PROXY_TO_CDP_LOG_LEVEL.verbose,
    }
  }
}

export { Config }
