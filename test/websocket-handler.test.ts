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
// @ts-ignore: Playwright types not fully recognized
import { chromium } from 'playwright'
import { connect } from '../src/websocket-handler.ts'

// Import CDP mock responses from the JSONC file
// Since we're using Deno, we'll use Deno's built-in file system API
const cdpMocksPath = new URL('./websocket-handler-mocks.jsonc', import.meta.url)
const cdpMocksText = await Deno.readTextFile(cdpMocksPath)

// Parse the JSONC file using the official parser
const cdpMocks = parseJsonc(cdpMocksText) as Record<string, Record<string, any>>

// We don't need these anymore as we'll use the mocks from the file
// const CLIENT_CDP_GET_VERSION_REQUEST = {
//   id: 1,
//   method: 'Browser.getVersion',
// }
//
// const BROWSER_CDP_GET_VERSION_RESPONSE = {
//   id: 1,
//   result: {
//     protocolVersion: '1.3',
//     product: 'Chrome/120.0.6099.129',
//     revision: '@c712e335-5aef-4617-9819-804c2da9',
//     userAgent:
//       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.129 Safari/537.36',
//     jsVersion: '12.0.267.8',
//   },
// }

// Helper function to ensure we use valid WebSocket close codes (1000-4999)
function getValidCloseCode(code: number): number {
  if (code < 1000 || code > 4999) {
    return 1000 // Normal closure
  }
  return code
}

// Test #1: Basic WebSocket message passing test
Deno.test('WebSocket handler properly proxies CDP messages', async () => {
  const TEST_PORT = 9898
  // Create a mock browser WebSocket server
  const mockBrowserServer = Deno.serve({
    port: TEST_PORT,
    hostname: '127.0.0.1',
    handler: (req: Request) => {
      if (req.headers.get('upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 400 })
      }

      const { socket, response } = Deno.upgradeWebSocket(req)

      socket.onopen = () => {
        console.log('Mock browser connection opened')
      }

      // The browser socket receives a message and responds based on our mocks
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
            'Target.getTargets': () => sendMockResponse('Target', 'getTargets'),
            'Target.createBrowserContext': () =>
              sendMockResponse('Target', 'createBrowserContext'),
            'Target.createTarget': () => {
              sendMockResponse('Target', 'createTarget')
              // After creating a target, send the Target.targetCreated event
              setTimeout(
                () =>
                  socket.send(JSON.stringify(cdpMocks.Target.targetCreated)),
                10,
              )
            },
            'Target.attachToTarget': () => {
              sendMockResponse('Target', 'attachToTarget')
              // Then send the Target.attachedToTarget event
              setTimeout(
                () =>
                  socket.send(JSON.stringify(cdpMocks.Target.attachedToTarget)),
                10,
              )
            },
            'Page.navigate': () => {
              sendMockResponse('Page', 'navigate')
              // Send navigation events
              setTimeout(() => {
                // Use mocks from the JSONC file for navigation events
                const navigationEvents = [
                  cdpMocks.Page.frameStartedLoading,
                  cdpMocks.Page.frameNavigated,
                  cdpMocks.Page.loadEventFired,
                ]

                // The loadEventFired event has a timestamp that should be updated to current time
                if (navigationEvents[2]?.params) {
                  navigationEvents[2].params.timestamp = Date.now() / 1000
                }

                for (const event of navigationEvents) {
                  socket.send(JSON.stringify(event))
                }
              }, 20)
            },
            'Runtime.evaluate': () => {
              // Handle Runtime.evaluate specially to echo back the expression
              const { expression } = message.params || {}
              const mockResponse = structuredClone(cdpMocks.Runtime.evaluate)
              // Set the expression value in the response
              if (expression && mockResponse.result?.result) {
                mockResponse.result.result.value = expression
              }
              mockResponse.id = responseId
              socket.send(JSON.stringify(mockResponse))
            },
          }

          // Handle standard method patterns like *.enable
          if (method?.includes('.enable')) {
            // Handle various enable requests generically
            const [domain] = method.split('.')
            const mockResponse = { id: responseId, result: {} }

            if (cdpMocks[domain]?.enable) {
              mockResponse.result = structuredClone(
                cdpMocks[domain].enable.result,
              )
            }

            socket.send(JSON.stringify(mockResponse))
          }
          // Look up specific handler from map
          else if (methodHandlers[method]) {
            methodHandlers[method]()
          }
          // Default case: return simple success
          else {
            // For any other request, return a simple success result
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

  // Set up our WebSocket handler proxy
  const proxyServer = Deno.serve({ port: 9899 }, (req) => {
    return connect(req, `ws://localhost:${TEST_PORT}`)
  })

  try {
    // Connect a real browser client (Playwright) to our proxy
    const browser = await chromium.connectOverCDP('ws://localhost:9899', {
      timeout: 5000, // Set a faster timeout (5 seconds instead of default 30)
    })

    console.log('Successfully connected via CDP')

    // If we got here, the connection was successful
    assertEquals(true, true)

    // Close browser cleanly
    await browser.close()
  } catch (err) {
    console.error('Test failed:', err)
    throw err
  } finally {
    // Ensure servers are closed
    proxyServer.shutdown()
    mockBrowserServer.shutdown()

    // Short delay to allow cleanup
    await delay(100)
  }
})

// Test #2: CDP-specific test with Playwright client
Deno.test('WebSocket handler works with Playwright CDP client', async () => {
  // Setup a mock CDP browser server
  const mockBrowserPort = 9223
  const mockBrowserHost = 'localhost'
  const mockBrowserPath =
    '/devtools/browser/c3d1e2f3-a4b5-c6d7-e8f9-0a1b2c3d4e5f'
  const mockBrowserServerController = new AbortController()

  // Setup the mock CDP browser server
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
        // This is what browsers typically respond with to a /json/version request
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

        // Handle messages from the client (via proxy)
        socket.onmessage = (event) => {
          const message =
            typeof event.data === 'string'
              ? event.data
              : new TextDecoder().decode(event.data as ArrayBuffer)

          console.log('Mock CDP Browser received:', message)

          try {
            // Parse the incoming CDP message
            const parsedMessage = JSON.parse(message)
            const { id, method } = parsedMessage

            console.log(`CDP Method: ${method}, ID: ${id}`)

            // Helper function to send mock responses
            const sendMockResponse = (domain: string, command: string) => {
              const mockResponse = structuredClone(cdpMocks[domain][command])
              if (!mockResponse?.method) {
                // It's a response, not an event
                mockResponse.id = id
                socket.send(JSON.stringify(mockResponse))
              }
            }

            // Helper for generic responses
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
            }
            // Handle Runtime.evaluate specially to echo back the expression
            else if (method === 'Runtime.evaluate') {
              const { expression } = parsedMessage.params || {}
              const mockResponse = structuredClone(cdpMocks.Runtime.evaluate)
              // Set the expression value in the response
              if (expression && mockResponse.result?.result) {
                mockResponse.result.result.value = expression
              }
              mockResponse.id = id
              socket.send(JSON.stringify(mockResponse))
            }
            // Find command in domain.command format
            else if (method?.includes('.')) {
              const [domain, command] = method.split('.')
              if (cdpMocks[domain]?.[command]) {
                sendMockResponse(domain, command)
              } else {
                console.log(
                  `No specific mock found for: ${method}, using generic success response`,
                )
                sendGenericResponse()
              }
            }
            // Default case
            else {
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
    // Setup a proxy server for CDP
    const proxyPort = 9995
    const proxyHost = 'localhost'
    const proxyServerController = new AbortController()

    // Start the proxy server
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

        // If this is a request for the browser's JSON version endpoint, proxy it
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

        // Handle WebSocket upgrade for the CDP endpoint
        if (
          request.headers.get('upgrade') === 'websocket' &&
          url.pathname === mockBrowserPath
        ) {
          const browserWebSocketUrl = `ws://${mockBrowserHost}:${mockBrowserPort}${mockBrowserPath}`
          return await connect(request, browserWebSocketUrl)
        }

        return new Response('Invalid request', { status: 400 })
      },
    )

    try {
      // Connect Playwright CDP client to our proxy with a faster timeout
      const fakeBrowserWebsocketDebuggerUrl = `ws://${proxyHost}:${proxyPort}${mockBrowserPath}`
      console.log(
        `Connecting Playwright to: ${fakeBrowserWebsocketDebuggerUrl}`,
      )

      const browser = await chromium.connectOverCDP(
        fakeBrowserWebsocketDebuggerUrl,
        {
          timeout: 5000, // Set a faster 5-second timeout instead of the default 30s
        },
      )

      try {
        const session = await browser.newBrowserCDPSession()
        const command = await session.send('Console.enable')
        console.log(
          'New browser CDP session created and Console.enable call succesful!',
          { result: command },
        )
      } catch (error) {
        console.error('Error during Runtime.evaluate:', error)
        throw error // Re-throw to fail the test
      }

      // If we reach here, the connection was successful
      console.log('Playwright CDP connection successful!')

      // Test passed!
      assertEquals(true, true)

      // Clean up
      await browser.close()

      // Add a delay to allow for connection closure
      await delay(100)
    } finally {
      // Shutdown the proxy server
      proxyServerController.abort()
      await proxyServer.finished

      // Wait a bit for resources to be cleaned up
      await delay(100)
    }
  } finally {
    // Shutdown the mock browser server
    mockBrowserServerController.abort()
    await mockCdpBrowserServer.finished
  }
})
