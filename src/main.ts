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
const ac = new AbortController()
//import { ProxyAgent } from './proxy-agent.ts'
import { ProxyRewriter } from './proxy-rewriter.ts'

const config = {
  port: 9994,
  hostname: "127.0.0.1",
}
const proxyRewriter = new ProxyRewriter(config.port, config.hostname)


const httpHandler = (req: Request): Promise<Response | null> => {
  console.log(Deno.inspect(req))
  return Promise.resolve(new Response('Hello, world'))
}

const server = Deno.serve({
  port: config.port,
  hostname: config.hostname,
  handler: proxyRewriter.handler([httpHandler]),
  signal: ac.signal,
  onListen({ port, hostname }) {
    console.log(`Server started at http://${hostname}:${port}`)
  },
})

// Add signal handlers for graceful shutdown
const handleShutdown = async () => {
  console.log("Closing server...")
  ac.abort()
  await server.shutdown()
};

// Add signal handlers for graceful shutdown
Deno.addSignalListener("SIGINT", handleShutdown);
Deno.addSignalListener("SIGTERM", handleShutdown);

// Handle uncaught exceptions
addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  console.error("Unhandled rejection:", event.reason);
  handleShutdown();
});

addEventListener("error", (event: ErrorEvent) => {
  console.error("Uncaught exception:", event.error);
  handleShutdown();
});

server.finished.then(() => {
  console.log("Server closed")
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