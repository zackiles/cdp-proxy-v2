/**
 * WebSocket Handler for Chrome DevTools Protocol Proxy
 *
 * This module implements a transparent MitM proxy between a client (like Playwright)
 * and a browser's Chrome DevTools Protocol WebSocket endpoint. It passes messages
 * bidirectionally while logging them for inspection.
 */

// Define WebSocket message types
type WSMessage = {
  direction: 'client-to-browser' | 'browser-to-client'
  message: string
  timestamp: number
}

/**
 * Ensures a WebSocket close code is valid (1000 or 3000-4999)
 * Close codes 1005 and others are internally used by the WebSocket protocol
 * and can't be used when manually closing a connection
 */
function ensureValidCloseCode(code: number): number {
  // If code is 1000 (normal closure) or in the 3000-4999 range (app specific), it's valid
  if (code === 1000 || (code >= 3000 && code <= 4999)) {
    return code
  }

  // Default to normal closure (1000) for invalid codes
  return 1000
}

/**
 * Connects a client to a browser through a transparent WebSocket proxy
 * @param clientRequest The original request from the client with upgrade headers
 * @param webSocketDebuggerUrl The target browser WebSocket URL to connect to
 * @returns Promise that resolves with the WebSocket upgrade response
 */
export async function connect(
  clientRequest: Request,
  webSocketDebuggerUrl: string,
): Promise<Response> {
  // Store all socket messages for future logging
  const messageLog: WSMessage[] = []

  console.log(
    'PROXY: Received client WebSocket upgrade request',
    Deno.inspect(
      {
        url: clientRequest.url,
        method: clientRequest.method,
        headers: Object.fromEntries(clientRequest.headers.entries()),
      },
      { depth: 3 },
    ),
  )

  // Verify this is a WebSocket upgrade request
  if (clientRequest.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    console.error('PROXY: Not a WebSocket upgrade request')
    return new Response('Expected WebSocket Upgrade', { status: 400 })
  }

  // Step 1: Rewrite client request to target the browser
  console.log(
    'PROXY: Rewriting client request to target browser',
    Deno.inspect({ targetUrl: webSocketDebuggerUrl }),
  )

  const browserUrl = new URL(webSocketDebuggerUrl)

  // Create a new request that targets the browser
  const clientHeaders = Object.fromEntries(clientRequest.headers.entries())
  const browserRequestHeaders = new Headers(clientHeaders)

  // Update the host header to point to the browser
  browserRequestHeaders.set('host', `${browserUrl.hostname}:${browserUrl.port}`)

  console.log(
    'PROXY: Created browser-bound request headers',
    Deno.inspect(
      {
        headers: Object.fromEntries(browserRequestHeaders.entries()),
      },
      { depth: 3 },
    ),
  )

  // Step 2: Connect to the browser WebSocket
  console.log('PROXY: Initiating WebSocket connection to browser')

  let browserSocket: WebSocket

  try {
    // Using raw WebSocket here as we need more control than fetch's upgrade mechanism
    browserSocket = new WebSocket(webSocketDebuggerUrl)

    // Promise that resolves when browser socket is open
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Browser WebSocket connection timeout'))
      }, 10000) // 10 second timeout

      browserSocket.onopen = () => {
        clearTimeout(timeout)
        console.log('PROXY: Browser WebSocket connection established')
        resolve()
      }

      browserSocket.onerror = (error) => {
        clearTimeout(timeout)
        console.error(
          'PROXY: Failed to connect to browser WebSocket',
          Deno.inspect({ error }),
        )
        reject(new Error('Failed to connect to browser WebSocket'))
      }
    })
  } catch (error: unknown) {
    console.error(
      'PROXY: Browser WebSocket connection failed',
      Deno.inspect({ error }),
    )
    return new Response(
      `Failed to connect to browser: ${error instanceof Error ? error.message : 'Unknown error'}`,
      {
        status: 502,
      },
    )
  }

  // Step 3: Prepare to respond to client with upgrade
  console.log('PROXY: Preparing response to client upgrade request')

  // In Deno, we use the upgradeWebSocket API to handle the WebSocket upgrade
  try {
    const { socket: clientSocket, response } =
      Deno.upgradeWebSocket(clientRequest)

    console.log('PROXY: Created client-facing WebSocket connection')

    // Step 4: Set up bidirectional message handling
    // Browser to Client
    browserSocket.onmessage = (event: MessageEvent) => {
      const message =
        typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer)
      console.log(
        'PROXY: Browser → Client message',
        Deno.inspect({
          messagePreview:
            message.length > 100 ? `${message.substring(0, 100)}...` : message,
          size: message.length,
        }),
      )

      messageLog.push({
        direction: 'browser-to-client',
        message,
        timestamp: Date.now(),
      })

      // Forward message to client
      if (clientSocket.readyState === WebSocket.OPEN) {
        try {
          clientSocket.send(event.data)
        } catch (error) {
          console.error(
            'PROXY: Error forwarding message to client',
            Deno.inspect({ error }),
          )
        }
      }
    }

    // Client to Browser
    clientSocket.onmessage = (event: MessageEvent) => {
      const message =
        typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer)
      console.log(
        'PROXY: Client → Browser message',
        Deno.inspect({
          messagePreview:
            message.length > 100 ? `${message.substring(0, 100)}...` : message,
          size: message.length,
        }),
      )

      messageLog.push({
        direction: 'client-to-browser',
        message,
        timestamp: Date.now(),
      })

      // Forward message to browser
      if (browserSocket.readyState === WebSocket.OPEN) {
        try {
          browserSocket.send(event.data)
        } catch (error) {
          console.error(
            'PROXY: Error forwarding message to browser',
            Deno.inspect({ error }),
          )
        }
      }
    }

    // Handle socket closures
    browserSocket.onclose = (event) => {
      console.log(
        'PROXY: Browser WebSocket closed',
        Deno.inspect({ code: event.code, reason: event.reason }),
      )

      if (clientSocket.readyState === WebSocket.OPEN) {
        const validCode = ensureValidCloseCode(event.code)
        clientSocket.close(validCode, event.reason)
      }
    }

    clientSocket.onclose = (event) => {
      console.log(
        'PROXY: Client WebSocket closed',
        Deno.inspect({ code: event.code, reason: event.reason }),
      )

      if (browserSocket.readyState === WebSocket.OPEN) {
        const validCode = ensureValidCloseCode(event.code)
        browserSocket.close(validCode, event.reason)
      }
    }

    // Handle errors
    browserSocket.onerror = (error) => {
      console.error('PROXY: Browser WebSocket error', Deno.inspect({ error }))
    }

    clientSocket.onerror = (error) => {
      console.error('PROXY: Client WebSocket error', Deno.inspect({ error }))
    }

    console.log(
      'PROXY: Connection fully established, messages will now flow bidirectionally',
    )

    // Return the WebSocket upgrade response
    return response
  } catch (error: unknown) {
    console.error(
      'PROXY: Failed to upgrade client connection',
      Deno.inspect({ error }),
    )
    browserSocket.close()
    return new Response(
      `Failed to upgrade connection: ${error instanceof Error ? error.message : 'Unknown error'}`,
      {
        status: 500,
      },
    )
  }
}
