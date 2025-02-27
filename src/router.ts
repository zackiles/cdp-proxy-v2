import type { HttpHandler } from './http-handler.ts'
import type { WebSocketHandler } from './websocket-handler.ts'
import { CDP_WEBSOCKET_PATHS } from './constants.ts'

let socketCount = 0

/**
 * Router function that handles both HTTP and WebSocket requests
 * @param httpHandler - Instance of HttpHandler for processing HTTP requests
 */
export function createRouterHandler(
  httpHandler: HttpHandler,
  webSocketHandler: WebSocketHandler,
) {
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

        return webSocketHandler.handle(req)
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
