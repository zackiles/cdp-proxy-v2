/**
 * End-to-End Tests for WebSocket Handler (CDP Proxy)
 *
 * These tests verify that our WebSocket handler can properly proxy connections
 * between a client and a browser implementing Chrome DevTools Protocol.
 *
 * TO RUN TESTS: "deno test --allow-all test/websocket-handler.test.ts"
 */

import { assertEquals } from '@std/assert'
import { delay } from '@std/async'
import { parse as parseJsonc } from '@std/jsonc'
import { getAvailablePort } from '@std/net'
// @ts-ignore: Playwright types not fully recognized
import { chromium } from 'playwright'
import { WebSocketHandler } from '../src/websocket-handler.ts'

const cdpMocksPath = new URL('./websocket-handler-mocks.jsonc', import.meta.url)
const cdpMocksText = await Deno.readTextFile(cdpMocksPath)
const cdpMocks = parseJsonc(cdpMocksText) as Record<string, Record<string, any>>

/**
 * Creates a WebSocketHandler instance for proxying CDP connections
 * @param options Options for WebSocketHandler creation
 * @returns A new WebSocketHandler instance
 */
function createWebSocketHandler({
  browserHost = 'localhost',
  browserPort,
}: {
  browserHost?: string
  browserPort: number
}) {
  return new WebSocketHandler({
    browserHost,
    browserPort,
  })
}

/**
 * Creates a Playwright CDP connection to the specified WebSocket URL
 * @param options Options for Playwright CDP connection
 * @returns Promise resolving to a Playwright Browser instance
 */
async function createPlaywrightInstance({
  url,
  timeout = 2000,
}: {
  url: string
  timeout?: number
}) {
  console.log(`Connecting Playwright to: ${url}`)

  const browser = await chromium.connectOverCDP(url, {
    timeout,
  })

  return browser
}

// Test #1: Basic WebSocket message passing test
Deno.test('WebSocket handler properly proxies CDP messages', async () => {
  const mockBrowserPort = await getAvailablePort()
  const proxyPort = await getAvailablePort()

  const mockBrowserServer = Deno.serve({
    port: mockBrowserPort,
    hostname: '127.0.0.1',
    handler: (req: Request) => {
      if (req.headers.get('upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 400 })
      }

      const { socket, response } = Deno.upgradeWebSocket(req)

      socket.onopen = () => {
        console.log('Mock browser connection opened')
      }

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          console.log('Mock browser received:', message)

          // Extract common parameters
          const { id: responseId, method } = message

          // Helper function to send mock responses
          const sendMockResponse = (domain: string, command: string) => {
            const mockResponse = structuredClone(cdpMocks[domain][command])
            mockResponse.id = responseId
            socket.send(JSON.stringify(mockResponse))
          }

          // Method handler map - maps method names to their handling functions
          const methodHandlers: Record<string, () => void> = {
            'Browser.getVersion': () =>
              sendMockResponse('Browser', 'getVersion'),
            'Target.setAutoAttach': () =>
              sendMockResponse('Target', 'setAutoAttach'),
            'Browser.setDownloadBehavior': () =>
              sendMockResponse('Browser', 'setDownloadBehavior'),
            'Target.getTargetInfo': () =>
              sendMockResponse('Target', 'getTargetInfo'),
            'Target.createBrowserContext': () =>
              sendMockResponse('Target', 'createBrowserContext'),
          }

          // Handle standard method patterns like *.enable
          if (method?.includes('.enable')) {
            const [domain] = method.split('.')
            const mockResponse = { id: responseId, result: {} }

            if (cdpMocks[domain]?.enable) {
              mockResponse.result = structuredClone(
                cdpMocks[domain].enable.result,
              )
            }

            socket.send(JSON.stringify(mockResponse))
          } else if (methodHandlers[method]) {
            methodHandlers[method]()
          } else {
            socket.send(JSON.stringify({ id: responseId, result: {} }))
          }
        } catch (err) {
          console.error('Error handling message in mock browser:', err)
        }
      }

      socket.onerror = (event) => {
        console.error('Mock browser socket error:', event)
      }

      socket.onclose = (event) => {
        console.log(`Mock browser socket closed with code ${event.code}`)
      }

      return response
    },
  })

  // Create the WebSocketHandler using the hoisted function
  const wsHandler = createWebSocketHandler({
    browserPort: mockBrowserPort,
  })

  const proxyServer = Deno.serve({ port: proxyPort }, (req) => {
    return wsHandler.handle(req)
  })

  try {
    // Connect a real browser client (Playwright) to our proxy using the hoisted function
    const browser = await createPlaywrightInstance({
      url: `ws://localhost:${proxyPort}`,
    })

    console.log('Successfully connected via CDP')
    assertEquals(true, true)

    await browser.close()
  } catch (err) {
    console.error('Test failed:', err)
    throw err
  } finally {
    proxyServer.shutdown()
    mockBrowserServer.shutdown()

    await delay(100)
  }
})

// Test #2: CDP-specific test with Playwright client
Deno.test('WebSocket handler works with Playwright CDP client', async () => {
  const mockBrowserPort = await getAvailablePort()
  const mockBrowserHost = 'localhost'
  const mockBrowserPath =
    '/devtools/browser/c3d1e2f3-a4b5-c6d7-e8f9-0a1b2c3d4e5f'
  const mockBrowserServerController = new AbortController()

  const mockCdpBrowserServer = Deno.serve(
    {
      port: mockBrowserPort,
      hostname: mockBrowserHost,
      signal: mockBrowserServerController.signal,
      onListen: () =>
        console.log(
          `Mock CDP browser server listening on ws://${mockBrowserHost}:${mockBrowserPort}`,
        ),
    },
    (request) => {
      const url = new URL(request.url)

      // Handle HTTP endpoint requests
      if (request.method === 'GET' && url.pathname === '/json/version') {
        return new Response(
          JSON.stringify({
            Browser: 'Chrome/120.0.6099.129',
            'Protocol-Version': '1.3',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.129 Safari/537.36',
            'V8-Version': '12.0.267.8',
            'WebKit-Version': '537.36',
            webSocketDebuggerUrl: `ws://${mockBrowserHost}:${mockBrowserPort}${mockBrowserPath}`,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      // Handle WebSocket upgrade for the CDP endpoint
      if (
        request.headers.get('upgrade') === 'websocket' &&
        url.pathname === mockBrowserPath
      ) {
        const { socket, response } = Deno.upgradeWebSocket(request)

        socket.onmessage = (event) => {
          const message =
            typeof event.data === 'string'
              ? event.data
              : new TextDecoder().decode(event.data as ArrayBuffer)

          console.log('Mock CDP Browser received:', message)

          try {
            const parsedMessage = JSON.parse(message)
            const { id, method } = parsedMessage

            console.log(`CDP Method: ${method}, ID: ${id}`)

            // Helper function to send mock responses
            const sendMockResponse = (domain: string, command: string) => {
              const mockResponse = structuredClone(cdpMocks[domain][command])
              if (!mockResponse?.method) {
                mockResponse.id = id
                socket.send(JSON.stringify(mockResponse))
              }
            }

            const sendGenericResponse = () => {
              socket.send(JSON.stringify({ id, result: {} }))
            }

            // Handle enable methods generically
            if (method?.includes('.enable')) {
              const [domain] = method.split('.')
              if (cdpMocks[domain]?.enable) {
                const mockResponse = structuredClone(cdpMocks[domain].enable)
                mockResponse.id = id
                socket.send(JSON.stringify(mockResponse))
              } else {
                sendGenericResponse()
              }
            } else if (method === 'Runtime.evaluate') {
              const { expression } = parsedMessage.params || {}
              const mockResponse = structuredClone(cdpMocks.Runtime.evaluate)
              if (expression && mockResponse.result?.result) {
                mockResponse.result.result.value = expression
              }
              mockResponse.id = id
              socket.send(JSON.stringify(mockResponse))
            } else if (method?.includes('.')) {
              const [domain, command] = method.split('.')
              if (cdpMocks[domain]?.[command]) {
                sendMockResponse(domain, command)
              } else {
                console.log(
                  `No specific mock found for: ${method}, using generic success response`,
                )
                sendGenericResponse()
              }
            } else {
              console.log(
                `No mock found for: ${method}, using generic success response`,
              )
              sendGenericResponse()
            }
          } catch (error) {
            console.error('Error parsing message:', error)
          }
        }

        socket.onclose = () => console.log('Mock CDP browser WebSocket closed')
        socket.onerror = (e) =>
          console.error('Mock CDP browser WebSocket error:', e)

        return response
      }

      return new Response('Invalid request', { status: 400 })
    },
  )

  try {
    const proxyPort = await getAvailablePort()
    const proxyHost = 'localhost'
    const proxyServerController = new AbortController()

    // Create a WebSocketHandler instance for the proxy using the hoisted function
    const wsHandler = createWebSocketHandler({
      browserHost: mockBrowserHost,
      browserPort: mockBrowserPort,
    })

    const proxyServer = Deno.serve(
      {
        port: proxyPort,
        hostname: proxyHost,
        signal: proxyServerController.signal,
        onListen: () =>
          console.log(
            `CDP Proxy server listening on ws://${proxyHost}:${proxyPort}`,
          ),
      },
      async (request) => {
        const url = new URL(request.url)

        if (request.method === 'GET' && url.pathname === '/json/version') {
          const browserVersionUrl = `http://${mockBrowserHost}:${mockBrowserPort}/json/version`
          const browserResponse = await fetch(browserVersionUrl)
          const browserVersionData = await browserResponse.json()

          // Rewrite the webSocketDebuggerUrl to point to our proxy
          browserVersionData.webSocketDebuggerUrl = `ws://${proxyHost}:${proxyPort}${mockBrowserPath}`

          return new Response(JSON.stringify(browserVersionData), {
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (
          request.headers.get('upgrade') === 'websocket' &&
          url.pathname === mockBrowserPath
        ) {
          return await wsHandler.handle(request)
        }

        return new Response('Invalid request', { status: 400 })
      },
    )

    try {
      const fakeBrowserWebsocketDebuggerUrl = `ws://${proxyHost}:${proxyPort}${mockBrowserPath}`

      // Connect to the proxy using the hoisted function with custom timeout
      const browser = await createPlaywrightInstance({
        url: fakeBrowserWebsocketDebuggerUrl,
        timeout: 5000, // Set a faster 5-second timeout instead of the default 30s
      })

      try {
        const session = await browser.newBrowserCDPSession()
        const command = await session.send('Console.enable')
        console.log(
          'New browser CDP session created and Console.enable call succesful!',
          { result: command },
        )
      } catch (error) {
        console.error('Error during Runtime.evaluate:', error)
        throw error
      }

      console.log('Playwright CDP connection successful!')

      assertEquals(true, true)

      await browser.close()
      await delay(100)
    } finally {
      proxyServerController.abort()
      await proxyServer.finished
      await delay(100)
    }
  } finally {
    mockBrowserServerController.abort()
    await mockCdpBrowserServer.finished
  }
})
