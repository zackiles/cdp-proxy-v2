/**
 * @file mitm_proxy.ts
 * A simple abstract MitM proxy for forwarding CDPMessage payloads between clients and browsers.
 */

import type { CDPMessage } from './types.ts'

export type ProxyCDPMessage = CDPMessage & {
  proxySessionId?: string
}

interface WebSocketStreamLike {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

class WebSocketStream implements WebSocketStreamLike {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>

  constructor(socket: WebSocket) {
    this.readable = new ReadableStream({
      start(controller) {
        socket.onmessage = (event) => {
          if (event.data instanceof Blob) {
            event.data.arrayBuffer().then((buffer) => {
              controller.enqueue(new Uint8Array(buffer))
            })
          } else if (event.data instanceof ArrayBuffer) {
            controller.enqueue(new Uint8Array(event.data))
          }
        }
        socket.onclose = () => controller.close()
        socket.onerror = (err) => controller.error(err)
      },
    })

    this.writable = new WritableStream({
      write(chunk) {
        if (socket.readyState === socket.OPEN) {
          socket.send(chunk)
        }
      },
    })
  }
}

export abstract class MitMProxy {
  private activeConnections = new Map<
    string,
    { clientId: string; browserId: string }
  >()

  abstract listen(port: number): Promise<void>
  abstract acquireBrowserSocket(browserId: string): Promise<WebSocket>
  abstract acquireClientSocket(clientId: string): Promise<WebSocket>

  protected generateProxySessionId(): string {
    return crypto.randomUUID()
  }

  protected async handleProxySession(clientId: string, browserId: string) {
    if (this.hasActiveConnection(clientId)) return
    const proxySessionId = this.generateProxySessionId()
    this.activeConnections.set(proxySessionId, { clientId, browserId })

    const clientSocket = await this.acquireClientSocket(clientId)
    const browserSocket = await this.acquireBrowserSocket(browserId)

    const clientStream = new WebSocketStream(clientSocket)
    const browserStream = new WebSocketStream(browserSocket)

    const clientReader = clientStream.readable.getReader()
    const clientWriter = browserStream.writable.getWriter()
    const browserReader = browserStream.readable.getReader()
    const browserWriter = clientStream.writable.getWriter()

    this.pipeMessages(
      clientReader,
      clientWriter,
      proxySessionId,
      'clientToBrowser',
    )
    this.pipeMessages(
      browserReader,
      browserWriter,
      proxySessionId,
      'browserToClient',
    )
  }

  protected hasActiveConnection(clientId: string) {
    for (const [, conn] of this.activeConnections) {
      if (conn.clientId === clientId) return true
    }
    return false
  }

  private async pipeMessages(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    proxySessionId: string,
    direction: 'clientToBrowser' | 'browserToClient',
  ) {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const messageText = new TextDecoder().decode(value)
      let parsed: ProxyCDPMessage
      try {
        parsed = JSON.parse(messageText)
      } catch {
        continue
      }
      parsed.proxySessionId = proxySessionId

      if (direction === 'browserToClient') {
        if ('id' in parsed) {
          // Interpreted as a CDPResponse
        } else {
          // Interpreted as a CDPEvent
        }
      } else {
        // Interpreted as a CDPRequest
      }

      const encoded = new TextEncoder().encode(JSON.stringify(parsed))
      await writer.write(encoded)
    }
    writer.close()
  }
}
