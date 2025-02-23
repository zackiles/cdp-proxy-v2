import { launch, type LaunchedChrome } from 'chrome-launcher'
import { BROWSER_LAUNCH_FLAGS } from './constants.ts'
import { waitForProcessExit } from './utils.ts'

class BrowserManager {
  #browser: LaunchedChrome | null = null
  browserHost: string
  browserPort: number
  browserExecutablePath: string
  browserWebSocketDebuggerUrl!: string

  constructor(browserHost: string, browserPort: number, browserExecutablePath: string) {
    this.browserHost = browserHost
    this.browserPort = browserPort
    this.browserExecutablePath = browserExecutablePath
  }


  async start(): Promise<void> {
    this.#browser = await launch({
      chromePath: this.browserExecutablePath,
      port: this.browserPort,
      chromeFlags: [
        ...BROWSER_LAUNCH_FLAGS, 
        `--remote-debugging-port=${this.browserPort}`,
        `--remote-debugging-address=${this.browserHost}`
      ],
      handleSIGINT: true,
    })
    this.browserWebSocketDebuggerUrl = await this.#getCDPWebSocketUrl()
    if(!this.browserWebSocketDebuggerUrl) {
      throw new Error(`Failed to start Browser on ${this.browserHost + this.browserPort}!`)
    }
  }

  async close(timeout: number = 5000): Promise<void> {
    if(!this.#browser || !this.#browser.pid) {
      throw new Error('Failed to close Browser, no browser running!')
    }
    this.#browser?.kill()
    return await waitForProcessExit(this.#browser.pid, timeout)
  }

  async #getCDPWebSocketUrl(): Promise<string> {
    try {
      console.debug(`Checking for an active CDP connection at http://${this.browserHost}:${this.browserPort}/json/version`)
      const response = await fetch(`http://${this.browserHost}:${this.browserPort}/json/version`)
  
      if (!response.ok) {
        console.debug(`Received HTTP ${response.status} from CDP endpoint`)
        return ''
      }
  
      const data = await response.json()
      if (data && typeof data.webSocketDebuggerUrl === "string") {
        console.debug(`CDP connection available, WebSocket URL: ${data.webSocketDebuggerUrl}`)
        return data.webSocketDebuggerUrl
      }
  
      console.warn('Unexpected response format from CDP endpoint:', data)
      return ''
    } catch (error) {
      console.debug(`Error while attempting to reach CDP endpoint: ${(error as Error).message}`)
      return ''
    }
  }
}

export { BrowserManager }