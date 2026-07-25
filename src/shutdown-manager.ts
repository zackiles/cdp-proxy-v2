/**
 * @module shutdown-manager
 * @description Coordinates graceful teardown: a shared `AbortSignal` for the
 * server, a set of {@link Closable} connections, and a cleanup hook (e.g. the
 * browser pool). OS-signal handling is opt-in: the standalone server exits on
 * SIGINT, but the in-process SDK path must NOT exit (that would kill the user's
 * own program), so programmatic `shutdownNow()` cleans up without exiting.
 */

import { Logger } from './logger.ts'
import { asError } from './utils.ts'

const log = Logger.get('shutdown')

/** Anything the shutdown manager can close (a `ProxyConnection`, a pool, …). */
export interface Closable {
  close(): void | Promise<void>
}

export interface ShutdownOptions {
  handleSignals?: boolean
}

export class ShutdownManager {
  readonly #controller = new AbortController()
  readonly #closables = new Set<Closable>()
  readonly #signalHandlers = new Map<Deno.Signal, () => void>()
  #cleanup?: () => void | Promise<void>
  #shuttingDown = false

  readonly #errorHandler = (e: ErrorEvent): void => {
    log.error('uncaught error', { error: asError(e.error) })
    this.#runAndExit().catch(() => {})
  }
  readonly #rejectionHandler = (e: PromiseRejectionEvent): void => {
    log.error('unhandled rejection', { error: asError(e.reason) })
    this.#runAndExit().catch(() => {})
  }

  constructor(options: ShutdownOptions = {}) {
    if (options.handleSignals ?? true) this.#installSignals()
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  onCleanup(fn: () => void | Promise<void>): void {
    this.#cleanup = fn
  }

  addClosable(c: Closable): void {
    this.#closables.add(c)
  }

  removeClosable(c: Closable): void {
    this.#closables.delete(c)
  }

  /** Programmatic teardown — cleans up but never exits the process. */
  async shutdownNow(): Promise<void> {
    await this.#run()
  }

  #installSignals(): void {
    addEventListener('error', this.#errorHandler)
    addEventListener('unhandledrejection', this.#rejectionHandler)

    const signals: Deno.Signal[] = Deno.build.os === 'windows'
      ? ['SIGINT', 'SIGBREAK']
      : ['SIGINT', 'SIGTERM', 'SIGHUP']

    for (const signal of signals) {
      const handler = () => {
        log.info(`received ${signal}, shutting down`)
        this.#runAndExit().catch(() => Deno.exit(1))
      }
      this.#signalHandlers.set(signal, handler)
      try {
        Deno.addSignalListener(signal, handler)
      } catch {
        /* some signals unavailable on some platforms */
      }
    }
  }

  async #runAndExit(): Promise<void> {
    await this.#run()
    Deno.exit(0)
  }

  async #run(): Promise<void> {
    if (this.#shuttingDown) return
    this.#shuttingDown = true

    try {
      this.#controller.abort()
    } catch {
      /* ignore */
    }

    await Promise.allSettled(
      [...this.#closables].map((c) =>
        Promise.resolve(c.close()).catch((e) =>
          log.warn('failed to close', { error: asError(e) })
        )
      ),
    )
    this.#closables.clear()

    await Promise.resolve(this.#cleanup?.()).catch((e) =>
      log.warn('cleanup hook failed', { error: asError(e) })
    )

    for (const [signal, handler] of this.#signalHandlers) {
      try {
        Deno.removeSignalListener(signal, handler)
      } catch {
        /* ignore */
      }
    }
    this.#signalHandlers.clear()
    removeEventListener('error', this.#errorHandler)
    removeEventListener('unhandledrejection', this.#rejectionHandler)
  }
}
