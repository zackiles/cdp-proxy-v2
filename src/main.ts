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
import '@std/dotenv/load'
import { getAvailablePort } from '@std/net'
const ac = new AbortController()
//import { ProxyAgent } from './proxy-agent.ts'
import { BrowserManager } from './browser-manager.ts'
import { HttpHandler } from './http-handler.ts'


const config = {
  proxyPort: Number(Deno.env.get('CDP_PROXY_PORT')) || getAvailablePort(),
  proxyHost: Deno.env.get('CDP_PROXY_HOST') || '0.0.0.0',
  browserPort: Number(Deno.env.get('CDP_BROWSER_PORT')) || getAvailablePort(),
  browserHost: Deno.env.get('CDP_BROWSER_HOST') || 'localhost',
  browserExecutablePath: Deno.env.get('CDP_BROWSER_EXECUTABLE_PATH') || '',
}

const browserManager = new BrowserManager(
  config.browserHost,
  config.browserPort,
  config.browserExecutablePath,
)

const httpHandler = new HttpHandler(config.browserHost, config.browserPort)

// Add signal handlers for graceful shutdown
const handleShutdown = async () => {
  // Show localhost for IPv6 loopback (::1) and IPv4 all interfaces on Windows (0.0.0.0)
  const displayHost = config.proxyHost === '::1' || (Deno.build.os === 'windows' && config.proxyHost === '0.0.0.0')
    ? 'localhost'
    : config.proxyHost
  console.log(
    `Closing server at http://${displayHost}:${config.proxyPort}...`,
  )
  try {
    ac.abort()
    await browserManager.close()
    await server.shutdown()
  } catch (error) {
    console.error('Error during shutdown:', error)
    Deno.exit(1)
  }
}

// Add signal handlers for graceful shutdown before starting services
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

await browserManager.start()

const server = Deno.serve({
  port: config.proxyPort,
  hostname: config.proxyHost,
  handler: httpHandler.handle,
  signal: ac.signal,
  onListen({ port, hostname }) {
    // For display purposes:
    // - If bound to all interfaces (0.0.0.0 or ::), show as localhost for Windows, actual IP otherwise
    // - If bound to loopback (127.0.0.1, ::1), show as localhost
    const displayHost = (hostname === '::1' || hostname === '127.0.0.1') || 
      ((hostname === '0.0.0.0' || hostname === '::') && Deno.build.os === 'windows')
      ? 'localhost' 
      : hostname
    const isAllInterfaces = hostname === '0.0.0.0' || hostname === '::'
    console.log(
      `Proxy server started at http://${displayHost}:${port}${isAllInterfaces ? ' and is accessible from all network interfaces!' : '!'}`
    )
  },
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
