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
import { createRouterHandler } from './router.ts'

const getProxyWebsocketDebuggerUrl = (browserWebSocketDebuggerUrl: string) => {
  const url = new URL(browserWebSocketDebuggerUrl)
  url.hostname = Config.get('proxyHost')
  url.port = Config.get('proxyPort').toString()
  return url.toString()
}

/**
 * Initializes the global Config singleton with environment variables
 */
async function setupConfig(): Promise<void> {
  const envVariables = recordToObject(await dotenv.load({ export: false }))
  const configOptions = await Config.create(envVariables as EnvVars)
  Config.setGlobal(new Config(configOptions))

  console.debug('Config initialized with final state:', {
    proxyPort: Config.get('proxyPort'),
    proxyHost: Config.get('proxyHost'),
    browserPort: Config.get('browserPort'),
    browserHost: Config.get('browserHost'),
    proxyLogLevel: Config.get('proxyLogLevel'),
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
function setupServer(
  httpHandler: HttpHandler,
  shutdownManager: ShutdownManager,
) {
  const config = Config.instance
  const port = config.get('proxyPort')
  const hostname = config.get('proxyHost')

  const displayHost =
    hostname === '::1' ||
    hostname === '127.0.0.1' ||
    ((hostname === '0.0.0.0' || hostname === '::') &&
      Deno.build.os === 'windows')
      ? 'localhost'
      : hostname
  const isAllInterfaces = hostname === '0.0.0.0' || hostname === '::'

  const server = Deno.serve({
    port,
    hostname,
    handler: createRouterHandler(httpHandler),
    signal: shutdownManager.signal,
    onListen: () =>
      console.log(
        `Proxy server started at http://${displayHost}:${port}${isAllInterfaces ? ' and is accessible from all network interfaces!' : '!'}`,
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
  const shutdownManager = new ShutdownManager()

  try {
    const httpHandler = new HttpHandler(
      Config.get('browserHost'),
      Config.get('browserPort'),
    )

    // Initialize browser and server
    const browserManager = await setupBrowser()
    const server = setupServer(httpHandler, shutdownManager)
    shutdownManager.setResources(browserManager, server)

    const debuggerUrl = browserManager.browser?.browserWebSocketDebuggerUrl
    if (!debuggerUrl) {
      throw new Error('Browser WebSocket debugger URL not available')
    }

    await connectAndNavigate(getProxyWebsocketDebuggerUrl(debuggerUrl))
  } catch (error) {
    console.error('Error during setup:', error)
    await shutdownManager.shutdownNow()
    throw error
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
