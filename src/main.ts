/**
Deno.env.set('DEBUG', 'pw:protocol')
Deno.env.set('BROWSER_MANAGER_DEBUG', '1')
Deno.env.set('DENO_ENV', 'test')

import { chromium } from '@browser-tools/browser-manager'
 
await chromium.install({
  platform: 'windows',
  arch: 'x64',
  customBasePath: '.cache',
})

console.log('installed')
*/
import * as dotenv from '@std/dotenv'
import { BrowserManager } from './browser-manager.ts'
import { HttpHandler } from './http-handler.ts'
import { connectAndNavigate } from './browser-agent.ts'
import { Config } from './config.ts'
import type { EnvVars } from './types.ts'
import { recordToObject } from './utils.ts'
import { ShutdownManager } from './shutdown-manager.ts'

/**
 * Initializes the global Config singleton with environment variables
 * This MUST be called before any other code tries to access Config.instance
 */
async function setupConfig(): Promise<void> {
  const envVariables = await dotenv.load({ export: false })
  const configOptions = await Config.create(recordToObject(envVariables) as EnvVars)
  const config = new Config(configOptions)
  Config.setGlobal(config)
  
  // Validate that the singleton was properly initialized
  const instance = Config.instance
  console.debug('Config singleton initialized with options:', {
    proxyPort: instance.get('proxyPort'),
    proxyHost: instance.get('proxyHost'),
    browserPort: instance.get('browserPort'),
    browserHost: instance.get('browserHost'),
    proxyLogLevel: instance.get('proxyLogLevel')
  })
}

/**
 * Sets up and starts the browser manager
 */
async function setupBrowser() {
  const config = Config.instance
  const browserManager = new BrowserManager(
    config.get('browserHost'),
    config.get('browserPort'),
    config.get('browserExecutablePath'),
  )

  await browserManager.start()

  if (!browserManager.browser?.browserWebSocketDebuggerUrl) {
    throw new Error('Browser WebSocket debugger URL not available')
  }

  return browserManager
}

/**
 * Sets up and starts the HTTP server
 */
function setupServer(httpHandler: HttpHandler, shutdownManager: ShutdownManager) {
  const config = Config.instance
  const port = config.get('proxyPort')
  const hostname = config.get('proxyHost')
  
  const displayHost = (hostname === '::1' || hostname === '127.0.0.1') || 
    ((hostname === '0.0.0.0' || hostname === '::') && Deno.build.os === 'windows')
    ? 'localhost' 
    : hostname
  const isAllInterfaces = hostname === '0.0.0.0' || hostname === '::'

  const server = Deno.serve({
    port,
    hostname,
    handler: httpHandler.handle,
    signal: shutdownManager.signal,
    onListen: () => console.log(
      `Proxy server started at http://${displayHost}:${port}${isAllInterfaces ? ' and is accessible from all network interfaces!' : '!'}`
    ),
  })

  server.finished.then(() => {
    console.debug('Server shutdown completed')
  })

  return server
}

/**
 * Main orchestration function that coordinates all workloads
 */
async function main() {
  // Setup core services
  await setupConfig()
  let shutdownManager

  try {
    // Initialize shutdown manager early to catch setup errors
    shutdownManager = new ShutdownManager()
    const { instance: config } = Config
    const httpHandler = new HttpHandler(
      config.get('browserHost'),
      config.get('browserPort')
    )

    // Initialize browser and server
    const browserManager = await setupBrowser()
    const server = setupServer(httpHandler, shutdownManager)

    // Register resources with shutdown manager
    shutdownManager.setResources(browserManager, server)

    const debuggerUrl = browserManager.browser?.browserWebSocketDebuggerUrl
    if (!debuggerUrl) {
      throw new Error('Browser WebSocket debugger URL not available')
    }

    await connectAndNavigate(debuggerUrl)
  } catch (error) {
    console.error('Error during setup:', error)
    // Trigger shutdown sequence if we have resources to clean up
    await shutdownManager.shutdownNow()
    throw error // Re-throw to ensure non-zero exit
  }
}

if (import.meta.main) {
  await main()
}

/**
const proxy = new ProxyAgent()

const clientWebSocket = new WebSocket('ws://localhost:9222/devtools/client');
const browserWebSocket = new WebSocket('ws://localhost:9222/devtools/browser');

proxy.createConnection(
clientWebSocket,
'ws://localhost:9222/devtools/browser'
)
 */
