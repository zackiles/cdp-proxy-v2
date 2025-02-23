import { launch, type LaunchedChrome } from 'chrome-launcher'
import { BROWSER_LAUNCH_FLAGS } from './constants.ts'

type BrowserStartResult = {
  browser: LaunchedChrome,
  browserWebSocketDebuggerUrl: string | null
}

export class BrowserManager {
  private browser!: LaunchedChrome
  private browserHost: string
  private browserPort: number
  private browserExecutablePath: string

  private browserWebSocketDebuggerUrl!: string

  constructor(browserHost: string, browserPort: number, browserExecutablePath: string) {
    this.browserHost = browserHost
    this.browserPort = browserPort
    this.browserExecutablePath = browserExecutablePath
  }


  async start(): Promise<BrowserStartResult> {
    this.browser = await launch({
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
    return { browser: this.browser, browserWebSocketDebuggerUrl: this.browserWebSocketDebuggerUrl }
  }

  async #getCDPWebSocketUrl(): Promise<string | null> {
    try {
      console.debug(`Checking for an active CDP connection at http://${this.browserHost}:${this.browserPort}/json/version`)
      const response = await fetch(`http://${this.browserHost}:${this.browserPort}/json/version`)
  
      if (!response.ok) {
        console.debug(`Received HTTP ${response.status} from CDP endpoint`)
        return null
      }
  
      const data = await response.json()
      if (data && typeof data.webSocketDebuggerUrl === "string") {
        console.debug(`CDP connection available, WebSocket URL: ${data.webSocketDebuggerUrl}`)
        return data.webSocketDebuggerUrl
      }
  
      console.warn('Unexpected response format from CDP endpoint:', data)
      return null
    } catch (error) {
      console.debug(`Error while attempting to reach CDP endpoint: ${(error as Error).message}`)
      return null
    }
  }
}