/**
 * @module ShutdownManager
 *
 * Manages the graceful shutdown of the application, handling OS signals, uncaught errors,
 * and resource cleanup. Provides a centralized mechanism for:
 * - Browser process management
 * - WebSocket connection handling
 * - Server shutdown
 * - Error and signal handling
 *
 * @example
 * // Basic usage
 * const shutdownManager = new ShutdownManager();
 * shutdownManager.setResources(browserManager, server);
 *
 * // Add WebSocket connection
 * shutdownManager.addWebSocketConnection(wsConnection);
 *
 * // Manual shutdown
 * await shutdownManager.shutdownNow();
 */
import { waitForProcessExit, killProcessOnPortByName } from './utils.ts'
import type { BrowserManager } from './browser-manager.ts'
import { Config } from './config.ts'
import type { WebSocketConnection } from './websocket-connection.ts'

const ABORT_CONTROLLER = new AbortController()

const TIMEOUTS = {
  BROWSER_CLOSE: 5000, //Timeout for browser graceful close (ms)
  BROWSER_PROCESS_EXIT: 10000, //Timeout for browser process exit verification (ms)
  SERVER_SHUTDOWN: 5000, //Timeout for server shutdown (ms)
} as const

type Resources = {
  browserManager?: BrowserManager
  server?: ReturnType<typeof Deno.serve>
  webSocketConnections: Set<WebSocketConnection>
}

/**
 * Manages graceful shutdown of the application by handling OS signals and uncaught errors.
 * Provides centralized cleanup of resources and handlers.
 */
class ShutdownManager {
  #handlers = new Map<Deno.Signal, () => Promise<void>>()
  #resources: Resources = {
    webSocketConnections: new Set(),
  }
  #isShuttingDown = false
  readonly #errorHandler = ({ error }: ErrorEvent): void => {
    console.error('Uncaught error:', error)
    this.#initiateShutdown().catch((e) =>
      console.error('Error in error shutdown handler:', e),
    )
  }
  readonly #rejectionHandler = ({ reason }: PromiseRejectionEvent): void => {
    console.error('Unhandled rejection:', reason)
    this.#initiateShutdown().catch((e) =>
      console.error('Error in rejection shutdown handler:', e),
    )
  }

  /** Get the abort signal for coordinated shutdown */
  get signal(): AbortSignal {
    return ABORT_CONTROLLER.signal
  }

  /**
   * Creates a new ShutdownManager instance
   * @constructor
   * @example
   * const shutdownManager = new ShutdownManager();
   */
  constructor() {
    this.#initializeLifecycleHandlers()
  }

  /**
   * Sets the primary resources to manage during shutdown
   * @param {BrowserManager} browserManager - Browser manager instance
   * @param {ReturnType<typeof Deno.serve>} [server] - HTTP server instance
   */
  setResources(
    browserManager: BrowserManager,
    server?: ReturnType<typeof Deno.serve>,
  ): void {
    this.#resources = {
      browserManager,
      server,
      webSocketConnections: new Set(),
    }
  }

  /**
   * Adds a WebSocket connection to be managed during shutdown
   * @param {WebSocketConnection} connection - WebSocket connection to manage
   */
  addWebSocketConnection(connection: WebSocketConnection): void {
    this.#resources.webSocketConnections.add(connection)
  }

  /**
   * Removes a WebSocket connection from management
   * @param {WebSocketConnection} connection - WebSocket connection to remove
   */
  removeWebSocketConnection(connection: WebSocketConnection): void {
    this.#resources.webSocketConnections.delete(connection)
  }

  /**
   * Initiates immediate shutdown sequence
   * @async
   * @returns {Promise<void>}
   * @example
   * await shutdownManager.shutdownNow();
   */
  async shutdownNow(): Promise<void> {
    await this.#initiateShutdown()
  }

  // PRIVATE API - Lifecycle Management
  #initializeLifecycleHandlers(): void {
    addEventListener('error', this.#errorHandler)
    addEventListener('unhandledrejection', this.#rejectionHandler)

    const platformSignals =
      Deno.build.os === 'windows'
        ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
        : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']

    for (const signal of platformSignals) {
      const handler = async () => {
        console.debug(`Received signal: ${signal}`)
        await this.#initiateShutdown().catch((error) =>
          console.error('Error in signal shutdown handler:', error),
        )
      }
      this.#handlers.set(signal as Deno.Signal, handler)
      Deno.addSignalListener(signal as Deno.Signal, handler)
    }
  }

  async #initiateShutdown(): Promise<void> {
    if (this.#isShuttingDown) {
      console.debug('Shutdown already in progress')
      return
    }
    this.#isShuttingDown = true

    if (!this.#resources.browserManager) {
      console.debug('No resources to clean up')
      return
    }

    this.#logShutdownStart()

    try {
      ABORT_CONTROLLER.abort()
      await this.#cleanup()
      Deno.exit(0)
    } catch (error) {
      console.error('Error during shutdown sequence:', error)
      await this.#forceCleanup().catch((e) =>
        console.error('Force cleanup also failed:', e),
      )
      Deno.exit(1)
    }
  }

  /**
   * Performs a graceful shutdown of all managed resources in a controlled sequence.
   * Attempts to clean up resources in the following order:
   * 1. WebSocket connections (graceful closure)
   * 2. Browser process (graceful shutdown with fallback to force kill)
   * 3. Server (allows connection draining before shutdown)
   * 4. Signal and error handlers
   *
   * Uses configured timeouts for each operation and provides detailed error logging.
   * This is the preferred shutdown path for normal operation.
   *
   * @throws {Error} If any critical cleanup operation fails
   * @returns {Promise<void>} Resolves when all cleanup tasks complete successfully
   */
  async #cleanup(): Promise<void> {
    const cleanupTasks: Promise<void>[] = []

    // WebSocket connections cleanup
    if (this.#resources.webSocketConnections.size) {
      const closeConnections = async () => {
        console.debug(
          `Cleaning up ${this.#resources.webSocketConnections.size} WebSocket connections...`,
        )
        await Promise.allSettled(
          [...this.#resources.webSocketConnections].map((conn) =>
            conn
              .close()
              .catch((error) =>
                console.warn('Failed to close WebSocket connection:', error),
              ),
          ),
        )
        this.#resources.webSocketConnections.clear()
      }
      cleanupTasks.push(closeConnections())
    }

    // Browser cleanup
    if (this.#resources.browserManager?.browser?.pid) {
      const closeBrowser = async () => {
        const { browserManager } = this.#resources
        if (!browserManager?.browser) return

        console.debug('Starting browser shutdown sequence...')
        const gracefulClose = browserManager.close()
        const timeoutError = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Browser graceful close timeout')),
            Math.floor(TIMEOUTS.BROWSER_CLOSE * 0.8),
          ),
        )

        await Promise.race([gracefulClose, timeoutError]).catch(() => {
          console.debug('Graceful browser shutdown failed, force killing...')
          return killProcessOnPortByName(
            browserManager.browserPort,
            /brave|chrome|edge/i,
          )
        })

        await waitForProcessExit(
          browserManager.browser.pid,
          TIMEOUTS.BROWSER_PROCESS_EXIT,
        ).catch((error) =>
          console.warn('Browser process exit verification failed:', error),
        )
      }
      cleanupTasks.push(
        closeBrowser().catch((error) => {
          console.error('Fatal error during browser shutdown:', error)
          throw error
        }),
      )
    }

    // Server cleanup
    if (this.#resources.server) {
      const closeServer = async () => {
        const { server } = this.#resources
        if (!server) return

        console.debug('Starting server shutdown sequence...')
        const DRAIN_PERIOD = Math.floor(TIMEOUTS.SERVER_SHUTDOWN * 0.2)
        await new Promise((resolve) => setTimeout(resolve, DRAIN_PERIOD))

        const shutdownTimeout = TIMEOUTS.SERVER_SHUTDOWN - DRAIN_PERIOD
        const serverShutdown = Promise.all([server.shutdown(), server.finished])
        const timeoutError = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Server shutdown timeout')),
            shutdownTimeout,
          ),
        )

        await Promise.race([serverShutdown, timeoutError])
      }
      cleanupTasks.push(
        closeServer().catch((error) => {
          console.error('Fatal error during server shutdown:', error)
          throw error
        }),
      )
    }

    // Handler cleanup
    const cleanupHandlers = () => {
      const signals = [...this.#handlers.entries()]
      const removeSignals = signals.map(
        ([signal, handler]) =>
          () =>
            Deno.removeSignalListener(signal, handler),
      )

      return Promise.resolve()
        .then(() => {
          for (const remove of removeSignals) {
            remove()
          }
          this.#handlers.clear()
          removeEventListener('error', this.#errorHandler)
          removeEventListener('unhandledrejection', this.#rejectionHandler)
        })
        .catch((error) => console.warn('Failed to unregister handlers:', error))
    }
    cleanupTasks.push(cleanupHandlers())

    await Promise.all(cleanupTasks)
    console.log('Graceful shutdown completed successfully')
  }

  /**
   * Performs an emergency cleanup of all resources when graceful shutdown fails.
   * This method:
   * - Immediately closes all WebSocket connections without waiting
   * - Force kills the browser process
   * - Forces server shutdown without connection draining
   * - Runs all cleanup operations in parallel
   *
   * Minimal error handling is performed, and most errors are silently ignored
   * to ensure resources are released. This is the fallback path when the
   * normal cleanup process fails.
   *
   * @returns {Promise<void>} Resolves when all force cleanup tasks complete
   */
  async #forceCleanup(): Promise<void> {
    console.debug('Initiating force cleanup...')
    const { webSocketConnections, browserManager, server } = this.#resources

    const cleanupTasks = [
      // WebSocket cleanup
      webSocketConnections.size &&
        Promise.resolve().then(() => {
          for (const conn of webSocketConnections) {
            conn.close().catch(() => {})
          }
          webSocketConnections.clear()
        }),

      // Browser cleanup
      browserManager?.browser?.pid &&
        killProcessOnPortByName(
          browserManager.browserPort,
          /brave|chrome|edge/i,
        ).catch((error) =>
          console.warn('Failed to force kill browser:', error),
        ),

      // Server cleanup
      server
        ?.shutdown()
        .catch((error) => console.warn('Failed to force close server:', error)),
    ].filter(Boolean)

    await Promise.allSettled(cleanupTasks)
  }

  #logShutdownStart(): void {
    const displayHost =
      Config.get('proxyHost') === '::1' ||
      (Deno.build.os === 'windows' && Config.get('proxyHost') === '0.0.0.0')
        ? 'localhost'
        : Config.get('proxyHost')

    console.log(
      `Closing server at http://${displayHost}:${Config.get('proxyPort')}...`,
    )
    console.debug('Starting graceful shutdown sequence...')
  }
}

export { ShutdownManager }
