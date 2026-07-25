/**
 * @module router
 * @description The proxy's front door: split CDP WebSocket upgrades from the
 * HTTP discovery endpoints, and name the OpenTelemetry span after the CDP route
 * so traces group by endpoint instead of by unique target id.
 */

import type { HttpHandler } from './http-handler.ts'
import type { WebSocketHandler } from './websocket-handler.ts'
import { CDP_HTTP_PATHS, CDP_WEBSOCKET_PATHS } from './constants.ts'
import { SESSION_TOKEN_HEADER } from './types.ts'
import { trace } from '@opentelemetry/api'
import { Logger } from './logger.ts'

export function createRouterHandler(
  httpHandler: HttpHandler,
  webSocketHandler: WebSocketHandler,
) {
  const log = Logger.get('router')

  return async function routerHandler(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/'
    // WebSocket paths carry a target id (`/devtools/browser/<uuid>`) so they match
    // by prefix; the discovery endpoints are exact.
    const socketPath = CDP_WEBSOCKET_PATHS.find((p) => path.startsWith(p))
    const route = socketPath ?? CDP_HTTP_PATHS.find((p) => p === path) ?? path

    const span = trace.getActiveSpan()
    span?.updateName(`${req.method} ${route}`)
    span?.setAttribute('http.route', route)
    span?.setAttribute('cdp.connection_type', socketPath ? 'websocket' : 'http')

    try {
      if (socketPath === '/devtools/page') {
        span?.setAttribute('cdp.result', 'not_implemented')
        return new Response(
          'Not implemented. Only browser targets using flatten=true will be proxied.',
          { status: 404 },
        )
      }

      if (socketPath) {
        // DANGER: never log the headers wholesale. They carry the session token,
        // which is a credential; whether one was sent is the only useful part.
        log.debug(`upgrading ${path}`, {
          session: req.headers.has(SESSION_TOKEN_HEADER)
            ? 'token'
            : 'anonymous',
        })
        return webSocketHandler.handle(req)
      }

      log.debug(`${req.method} ${path}`)
      return await httpHandler.handle(req)
    } catch (cause: unknown) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      span?.setAttribute('error', true)
      span?.setAttribute('error.message', error.message)
      log.error(`${req.method} ${path} failed`, { error })
      return new Response(`Internal Server Error: ${error.message}`, {
        status: 500,
      })
    }
  }
}
