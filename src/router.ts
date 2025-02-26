import type { HttpHandler } from './http-handler.ts'
import { CDP_WEBSOCKET_PATHS } from './constants.ts'
import { WebSocketConnection } from './websocket-connection.ts'
import { Config } from './config.ts'

let socketCount = 0

/**
 * Router function that handles both HTTP and WebSocket requests
 * @param httpHandler - Instance of HttpHandler for processing HTTP requests
 */
export function createRouterHandler(httpHandler: HttpHandler) {
  return async function routerHandler(req: Request): Promise<Response> {
    const requestUrl = new URL(req.url)
    const requestPath = requestUrl.pathname
    console.debug('RouterHandler.handle()', {
      requestUrl,
      requestPath,
    })

    try {
      // Check if the path matches any of the WebSocket paths
      const isWebSocketPath = CDP_WEBSOCKET_PATHS.some((path) =>
        requestPath.startsWith(path),
      )

      if (isWebSocketPath) {
        socketCount++
        console.log('Socket count:', socketCount)
        // Handle specific WebSocket paths
        if (requestPath.startsWith('/devtools/page')) {
          return new Response(
            'Not implemented. Only browser targets using flatten=true will be proxied.',
            { status: 404 },
          )
        }

        return handleWebSocket(req)
      }

      // If not a WebSocket path, delegate to HttpHandler
      return await httpHandler.handle(req)
    } catch (error: unknown) {
      console.error('Error in RouterHandler.handle():', error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      return new Response(`Internal Server Error: ${errorMessage}`, {
        status: 500,
      })
    }
  }
}

/**
 * Handles WebSocket connections by upgrading the connection and proxying to the browser
 * @param request - The original HTTP request
 * @returns A Response object with the upgraded WebSocket connection
 */
function handleWebSocket(request: Request): Response {
  console.debug('RouterHandler.handleWebSocket()')

  // Extract the full path from the original request URL
  const requestUrl = new URL(request.url)
  const browserWSUrl = `ws://${Config.get('browserHost')}:${Config.get('browserPort')}${requestUrl.pathname}`
  console.debug('Using browser WebSocket URL:', browserWSUrl)

  // Create WebSocket upgrade
  const { socket, response } = Deno.upgradeWebSocket(request)

  let wsConnection: WebSocketConnection | null = null
  let firstMessageHandled = false

  // Set up event listeners
  socket.addEventListener('open', () => {
    console.log('Client connected to WebSocket')
  })

  socket.addEventListener('error', (error) => {
    console.error('WebSocket error:', error)
    wsConnection?.close().catch(console.error)
  })

  socket.addEventListener('close', () => {
    console.log('Client disconnected')
    wsConnection?.close().catch(console.error)
  })

  // Handle messages from client
  socket.addEventListener('message', async (event) => {
    try {
      // Special case for ping/pong heartbeat
      if (event.data === 'ping') {
        socket.send('pong')
        return
      }

      // Handle the first CDP message to initialize the connection
      if (!firstMessageHandled) {
        firstMessageHandled = true

        try {
          // Parse the first message
          const firstMessage = JSON.parse(event.data)

          if (!firstMessage.id) {
            console.error(
              'First message missing ID, cannot establish connection:',
              firstMessage,
            )
            socket.close(1008, 'Invalid CDP message format')
            return
          }

          console.debug('Received first CDP message:', firstMessage)

          // Create the WebSocket connection manager
          wsConnection = new WebSocketConnection(
            socket,
            (clientMessage) =>
              console.debug('Client → Browser:', clientMessage),
            (browserMessage) =>
              console.debug('Browser → Client:', browserMessage),
          )

          // Connect to browser and start proxying
          await wsConnection.connect(browserWSUrl, firstMessage)
          console.log('WebSocket proxy connected and forwarding messages')
        } catch (error) {
          console.error(
            'RouterHandler.handleWebSocket() Failed to establish WebSocket proxy connection:',
            error,
          )
          //socket.close(1011, 'Failed to establish connection to browser')
        }
      }
      // First message already handled, WebSocketConnection will handle subsequent messages
    } catch (error) {
      console.error(
        'RouterHandler.handleWebSocket() Error handling WebSocket message:',
        error,
      )
    }
  })

  return response
}
