import type { HttpHandler } from './http-handler.ts'
import { CDP_WEBSOCKET_PATHS } from './constants.ts'
import { WebSocketConnection } from './websocket-handler.ts'
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
    console.debug(`Router.handle() ${requestUrl.href}`)

    try {
      // Check if the path matches any of the WebSocket paths
      const isWebSocketPath = CDP_WEBSOCKET_PATHS.some((path) =>
        requestPath.startsWith(path),
      )

      if (isWebSocketPath) {
        // Log WebSocket upgrade request details
        console.debug('Router.handle() Incoming WebSocket path:', requestPath)
        console.debug(
          'Router.handle() WebSocket headers:',
          Object.fromEntries(req.headers.entries()),
        )

        socketCount++
        console.log('Router.handle() Socket count:', socketCount)
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
      console.error(
        'Router.handle() Error:',
        Deno.inspect(error, {
          colors: true,
          depth: 0,
        }),
      )
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
  console.debug('Router.handleWebSocket() Request URL:', request.url)

  // Extract the full path from the original request URL
  const requestUrl = new URL(request.url)
  const browserWSUrl = `ws://${Config.get('browserHost')}:${Config.get('browserPort')}${requestUrl.pathname}`
  console.debug('Router.handleWebSocket() Browser WebSocket URL:', browserWSUrl)

  // Check if this connection is already upgraded
  const upgradeHeader = request.headers.get('upgrade')?.toLowerCase()
  const connectionHeader = request.headers.get('connection')?.toLowerCase()
  const isAlreadyUpgraded =
    !upgradeHeader?.includes('websocket') ||
    !connectionHeader?.includes('upgrade')

  if (isAlreadyUpgraded) {
    console.debug(
      'Router.handleWebSocket() Request already upgraded, ignoring duplicate upgrade attempt',
    )
    return new Response('WebSocket connection already established', {
      status: 409,
    })
  }

  // Create WebSocket upgrade
  const { socket, response } = Deno.upgradeWebSocket(request)
  console.debug(
    'Router.handleWebSocket() Deno.upgradeWebSocket response headers:',
    Object.fromEntries(response.headers.entries()),
  )

  let wsConnection: WebSocketConnection | null = null
  let firstMessageHandled = false

  // Set up event listeners
  socket.addEventListener('open', () => {
    console.log('Router.handleWebSocket() Connection established')
  })

  socket.addEventListener('error', (error) => {
    console.error('Router.handleWebSocket() Error:', error)
    wsConnection?.close().catch(console.error)
  })

  socket.addEventListener('close', () => {
    console.log('Router.handleWebSocket() Connection closed')
    wsConnection?.close().catch(console.error)
  })

  // Handle messages from client
  socket.addEventListener('message', async (event) => {
    try {
      // Special case for ping/pong heartbeat
      if (event.data === 'ping') {
        console.debug('Router.handleWebSocket() Received ping')
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
              'Router.handleWebSocket() First message missing ID:',
              firstMessage,
            )
            socket.close(1008, 'Invalid CDP message format')
            return
          }

          console.debug(
            'Router.handleWebSocket() Received first CDP message:',
            firstMessage,
          )

          // Create the WebSocket connection manager
          wsConnection = new WebSocketConnection(
            socket,
            (clientMessage) =>
              console.debug(
                'Router.handleWebSocket() Client → Browser:',
                clientMessage,
              ),
            (browserMessage) =>
              console.debug(
                'Router.handleWebSocket() Browser → Client:',
                browserMessage,
              ),
          )

          // Connect to browser and start proxying
          await wsConnection.connect(browserWSUrl, firstMessage)
          console.log(
            'Router.handleWebSocket() WebSocket proxy connected and forwarding messages',
          )
        } catch (error) {
          console.error(
            'Router.handleWebSocket() Failed to establish proxy connection:',
            Deno.inspect(error, {
              colors: true,
              depth: 0,
            }),
          )
          socket.close(1011, 'Failed to establish connection to browser')
        }
      }
      // First message already handled, WebSocketConnection will handle subsequent messages
    } catch (error) {
      console.error(
        'Router.handleWebSocket() Error handling message:',
        Deno.inspect(error, {
          colors: true,
          depth: 0,
        }),
      )
    }
  })
  console.log(
    'Router.handleWebSocket() Returned upgrade response. Wating for client to connect over socket...',
  )
  return response
}
