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
import { getAvailablePort } from '@std/net'
const ac = new AbortController()
//import { ProxyAgent } from './proxy-agent.ts'
import { BrowserManager } from './browser-manager.ts'
import { httpHandler } from './http-handler.ts'

const config = {
  proxyPort: Number(Deno.env.get('CDP_PROXY_PORT')) || getAvailablePort(),
  browserPort: Number(Deno.env.get('BROWSER_PORT')) || getAvailablePort(),
  hostname: Deno.env.get('CDP_PROXY_HOSTNAME') || '0.0.0.0',
  browserExecutablePath: Deno.env.get('BROWSER_EXECUTABLE_PATH'),
}



const server = Deno.serve({
  port: config.proxyPort,
  hostname: config.hostname,
  handler: httpHandler,
  signal: ac.signal,
  onListen({ port, hostname }) {
    console.log(`Server started at http://${hostname}:${port!}`)
  },
})

const browserManager = new BrowserManager(
  config.hostname,
  config.browserPort,
  config.browserExecutablePath || '',
)
const { browser, browserWebSocketDebuggerUrl } = await browserManager.start()
console.log(`Browser debugger url started at ${browserWebSocketDebuggerUrl}`)

// Add signal handlers for graceful shutdown
const handleShutdown = async () => {
  console.log(
    `Closing server at http://${config.hostname}:${config.proxyPort}...`,
  )
  ac.abort()
  await server.shutdown()
}

// Add signal handlers for graceful shutdown
Deno.addSignalListener('SIGINT', handleShutdown)
Deno.addSignalListener('SIGTERM', handleShutdown)

// Handle uncaught exceptions
addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  console.error('Unhandled rejection:', event.reason)
  handleShutdown()
})

addEventListener('error', (event: ErrorEvent) => {
  console.error('Uncaught exception:', event.error)
  handleShutdown()
})

server.finished.then(() => {
  console.log('Server closed!')
  Deno.exit(0)
})

/**
const proxy = new ProxyAgent()

const clientWebSocket = new WebSocket('ws://localhost:9222/devtools/client');
const browserWebSocket = new WebSocket('ws://localhost:9222/devtools/browser');

proxy.createConnection(
clientWebSocket,
'ws://localhost:9222/devtools/browser'
)
 */
