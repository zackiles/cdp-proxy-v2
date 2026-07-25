/**
 * @module websocket-handler
 * @description Thin WebSocket upgrader (§13). Upgrades the client request and
 * hands the raw socket to the orchestrator, which builds the {@link
 * ProxyConnection} (upstream connect, plugin pipeline, id remap) — see
 * `proxy-connection.ts`. The previous transparent-pass-through implementation
 * lived here; it is now owned per-connection by `ProxyConnection`.
 *
 * DANGER: never `await` the client socket's `onopen` before returning the
 * upgrade Response — in Deno the socket only opens *after* the response is
 * returned, so awaiting it here deadlocks the handshake (the original bug).
 */

import { Logger } from './logger.ts'
import { asError } from './utils.ts'

export class WebSocketHandler {
  readonly #onSocket: (request: Request, socket: WebSocket) => void

  constructor(onSocket: (request: Request, socket: WebSocket) => void) {
    this.#onSocket = onSocket
  }

  handle(request: Request): Response {
    try {
      const { response, socket } = Deno.upgradeWebSocket(request)
      this.#onSocket(request, socket)
      return response
    } catch (cause: unknown) {
      const error = asError(cause)
      Logger.get('websocket').error('upgrade failed', { error })
      return new Response(`WebSocket upgrade failed: ${error.message}`, {
        status: 400,
      })
    }
  }
}
