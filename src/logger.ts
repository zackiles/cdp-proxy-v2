/**
 * @module logger
 * @description Level- and tag-filtered logging for every module. Writes a
 * readable line to the console and mirrors the record to OpenTelemetry.
 *
 * DANGER: do not install a global OTel `LoggerProvider` here. Doing so hijacks a
 * choice that belongs to the host application, and an earlier version of this file
 * registered no provider at all while still emitting through the API — which made
 * `logs.getLogger()` a no-op and silently swallowed every log line in the project.
 * The console sink below is what guarantees output; the OTel emit is a bonus that
 * only materializes once the host registers a provider of its own.
 */

import { logs } from '@opentelemetry/api-logs'
import { Config } from './config.ts'

export type LogLevelName =
  | 'silent'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug'
  | 'log'
  | 'verbose'

interface LoggerConfig {
  level?: LogLevelName
  tags?: string[]
}

interface LogData {
  sessionId?: string
  error?: Error
  [key: string]: unknown
}

const LOG_LEVELS: Record<LogLevelName, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  log: 5,
  verbose: 6,
}

const logger = logs.getLogger('cdp-proxy')

// DANGER: resolve the console method by name at call time. Capturing
// `console.error` here instead binds it before anything can intercept the
// console, which silently defeats both test capture and host log forwarding.
const SINKS: Record<LogLevelName, 'error' | 'warn' | 'info' | 'debug'> = {
  silent: 'debug',
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
  log: 'debug',
  verbose: 'debug',
}

export class Logger {
  private static readonly instances = new Map<string, Logger>()
  // Logging must never be the thing that breaks a module, so both globals fall
  // back to sane defaults when no global Config has been installed (unit tests,
  // library embedding).
  private static get globalTags(): string[] {
    try {
      return Config.get('proxyLogTags')?.split(',') || []
    } catch {
      return []
    }
  }

  private static normalizeLogLevel(level?: string | null): LogLevelName {
    return level &&
        LOG_LEVELS[level.toLowerCase() as LogLevelName] !== undefined
      ? (level.toLowerCase() as LogLevelName)
      : 'info'
  }

  private static get globalLevel(): LogLevelName {
    try {
      return Logger.normalizeLogLevel(Config.get('proxyLogLevel'))
    } catch {
      return 'info'
    }
  }

  static clearInstances(): void {
    Logger.instances.clear()
  }

  // DANGER: do not freeze the level here. Instances are cached, and a logger
  // built before the global Config exists would keep the fallback level forever.
  // `shouldLog` resolves it per call instead.
  private constructor(
    private readonly context: string,
    private config: LoggerConfig = {},
  ) {
    this.config = { tags: [], ...config }
  }

  static get(context: string, config?: LoggerConfig): Logger {
    const key = `${context}-${JSON.stringify(config)}`
    if (!Logger.instances.has(key)) {
      Logger.instances.set(key, new Logger(context, config))
    }
    return Logger.instances.get(key) ?? new Logger(context, config)
  }

  withTags = (tags: string[]): Logger =>
    Logger.get(this.context, {
      ...this.config,
      tags: [...(this.config.tags ?? []), ...tags],
    })

  private shouldLog(level: LogLevelName): boolean {
    return LOG_LEVELS[level] <=
      LOG_LEVELS[this.config.level ?? Logger.globalLevel]
  }

  private emitLog(
    level: LogLevelName,
    messageOrError: string | Error,
    data?: LogData,
  ): void {
    if (!this.shouldLog(level)) return

    const message = messageOrError instanceof Error
      ? messageOrError.message
      : messageOrError
    const errorToLog = messageOrError instanceof Error
      ? messageOrError
      : data?.error

    const attributes: Record<string, string> = {
      context: this.context,
      tags: this.config.tags?.join(', ') ?? '',
      error: errorToLog?.stack ?? '',
    }
    for (const [key, value] of Object.entries(data ?? {})) {
      if (key === 'error') continue
      attributes[key] = typeof value === 'string' ? value : Deno.inspect(value)
    }

    logger.emit({
      severityText: level.toUpperCase(),
      body: message,
      attributes,
    })

    const tags = this.config.tags?.length
      ? ` (${this.config.tags.join(', ')})`
      : ''
    const extra = Object.keys(data ?? {}).filter((k) => k !== 'error')
    const detail = extra.length
      ? ' ' + extra.map((k) => `${k}=${attributes[k]}`).join(' ')
      : ''
    const write = console[SINKS[level]]
    write(
      `${
        level.toUpperCase().padEnd(5)
      } ${this.context}${tags}: ${message}${detail}`,
    )
    if (errorToLog?.stack) write(errorToLog.stack)
  }

  verbose = (messageOrError: string | Error, data?: LogData) =>
    this.emitLog('verbose', messageOrError, data)
  log = (messageOrError: string | Error, data?: LogData) =>
    this.emitLog('log', messageOrError, data)
  debug = (messageOrError: string | Error, data?: LogData) =>
    this.emitLog('debug', messageOrError, data)
  info = (messageOrError: string | Error, data?: LogData) =>
    this.emitLog('info', messageOrError, data)
  warn = (messageOrError: string | Error, data?: LogData) =>
    this.emitLog('warn', messageOrError, data)
  error = (messageOrError: string | Error, data?: LogData) =>
    this.emitLog('error', messageOrError, data)
}
