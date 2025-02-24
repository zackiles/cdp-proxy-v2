/**
 * Manages a Browser instance for CDP (Chrome DevTools Protocol) connections.
 * Handles browser lifecycle including launch, connection, and graceful shutdown.
 */
import { launch, Launcher, type LaunchedChrome } from 'chrome-launcher'
import { BROWSER_LAUNCH_FLAGS, PROXY_TO_CDP_LOG_LEVEL } from './constants.ts'
import { waitForProcessExit, killProcessOnPortByName } from './utils.ts'

interface LaunchedBrowser extends LaunchedChrome {
  browserWebSocketDebuggerUrl?: string
}

class BrowserManager {
  #browser?: LaunchedBrowser
  browserHost: string
  browserPort: number
  browserExecutablePath: string
  

  /**
   * Creates a new BrowserManager instance
   * @param browserHost - Host address for remote debugging
   * @param browserPort - Port for remote debugging connection
   * @param browserExecutablePath - Path to Browser executable
   */
  constructor(browserHost: string, browserPort: number, browserExecutablePath: string) {
    this.browserHost = browserHost
    this.browserPort = browserPort
    this.browserExecutablePath = browserExecutablePath
  }

  /**
   * Starts the browser instance and establishes CDP connection
   * @throws {Error} If browser fails to launch or CDP connection fails
   */
  async start(): Promise<void> {
    const logLevel = (Deno.env.get('CDP_LOG_LEVEL') as "silent" | "error" | "warn" | "info" | "verbose" | undefined) || 'verbose'

    console.debug(`Ensuring a browser is not already running on port ${this.browserPort}...`)

    await killProcessOnPortByName(this.browserPort, /brave|chrome|edge/i)

    console.debug('Starting browser...', {
      browserHost: this.browserHost,
      browserPort: this.browserPort,
      browserExecutablePath: this.browserExecutablePath,
      browserLaunchFlags: this.simulateFinalLaunchFlags()
    })

    try {
      this.#browser = await launch({
        chromePath: this.browserExecutablePath,
        port: Number(this.browserPort),
        userDataDir: false,
        logLevel: logLevel,
        maxConnectionRetries: 2,
        connectionPollInterval: 500,
        startingUrl: undefined, 
        chromeFlags: [
          ...BROWSER_LAUNCH_FLAGS, 
          `--remote-debugging-port=${this.browserPort}`,
          `--remote-debugging-address=${this.browserHost}`,
          `--v=${PROXY_TO_CDP_LOG_LEVEL[logLevel]}`,
          '--disable-gcm',
          '--disable-sync',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-component-update',
          '--disable-web-security',
          '--allow-running-insecure-content',
          '--ignore-certificate-errors'
        ],
        handleSIGINT: true
      })
      console.log('chrome-launcher.launch() returned', this.#browser)
      // Capture process output
      if (this.#browser?.process) {
        this.#browser.process.stderr?.on('data', (data) => {
          console.error('Browser stderr:', data.toString())
        })
        this.#browser.process.stdout?.on('data', (data) => {
          console.debug('Browser stdout:', data.toString())
        })
      }

      this.#browser.browserWebSocketDebuggerUrl = await this.#getCDPWebSocketUrl()
      console.log('Browser started at', this.#browser.browserWebSocketDebuggerUrl)
    } catch (error) {
      console.error('Browser launch failed:', error)
      if (error instanceof Error) {
        console.error('Error message:', error.message)
        console.error('Stack trace:', error.stack)
      }
      throw error
    }
  }

  /**
   * Gracefully closes the browser instance
   * @param timeout - Maximum time to wait for browser to close (ms)
   * @throws {Error} If no browser is running or close operation times out
   */
  async close(timeout: number = 5000): Promise<void> {
    if(!this.#browser?.pid) {
      throw new Error('Failed to close Browser, no browser running!')
    }
    this.#browser.kill()
    await killProcessOnPortByName(this.browserPort, /brave|chrome|edge/i)
    return await waitForProcessExit(this.#browser.pid, timeout)
  }

  /**
   * Simulates the final set of the launch flags sent to the browser as accurately as possible.
   * The steps to simulate are roughly:
   * 1. Start with default flags from chrome-launcher
   * 2. Add user configurable flags provided at runtime to the proxy, and attempt tosimulate the same logic chrome-launcher uses for conflict resolution with its default flags.
   * 3. Add any known intenal-flags that the proxy or chrome-launcher uses.
   * 
   * Note: The actual flags used may differ slightly as chrome-launcher internally
   * adds some flags based on runtime conditions and platform specifics.
   * 
   * @returns {string[]} Array of the most likely final flags used to launch the browser.
   */
  simulateFinalLaunchFlags(): string[] {
    // Default flags from chrome-launcher
    const defaultFlags = Launcher.defaultFlags()
    
    const customFlagMap = new Map(
      BROWSER_LAUNCH_FLAGS.map(flag => {
        const [name, value] = flag.split('=')
        return [name, value]
      })
    )

    // Start with defaults that don't conflict with our custom flags
    const finalFlags = defaultFlags.filter(flag => {
      const [name] = flag.split('=')
      return !customFlagMap.has(name)
    })

    // User supplied flags to the proxy config
    finalFlags.push(...BROWSER_LAUNCH_FLAGS)

    // Odds and ends
    const extraFlags = [
      // We add these only in the start() method, and they're contained neither in the user supplied flags to the proxy config nor the default flags of chrome-launcher.
      `--remote-debugging-port=${this.browserPort}`,
      `--remote-debugging-address=${this.browserHost}`,
      // These flags are technically added by chrome-launcher internally but not exposed via defaultFlags()
      '--remote-debugging-port',
      '--disable-setuid-sandbox', 
      '--user-data-dir'
    ]
    finalFlags.push(...extraFlags)

    return finalFlags
  }

  /**
   * Retrieves the WebSocket debugger URL for CDP connection
   * @param timeout - Maximum time to wait for CDP endpoint (ms)
   * @returns WebSocket URL for CDP connection
   * @throws {Error} If CDP endpoint is unreachable or returns invalid data
   */
  async #getCDPWebSocketUrl(timeout: number = 5000): Promise<string> {
    const endpoint = `http://${this.browserHost}:${this.browserPort}/json/version`
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(endpoint, { signal: controller.signal })
      clearTimeout(timeoutId)
      
      if (!response.ok) {
        throw new Error(`CDP endpoint returned HTTP ${response.status}`)
      }

      const { webSocketDebuggerUrl } = await response.json()
      if (!webSocketDebuggerUrl) {
        throw new Error('CDP endpoint returned no WebSocket URL')
      }

      return webSocketDebuggerUrl
    } catch (error: unknown) {
      clearTimeout(timeoutId)
      const message = error instanceof Error ? error.message : String(error)
      console.error(`CDP connection failed: ${message}`)
      throw new Error(`Failed to connect to browser at ${endpoint}: ${message}`)
    }
  }
}

export { BrowserManager }