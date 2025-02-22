/**
 * @module websocket-manager
 *
 * A module providing WebSocket proxy functionality for Chrome DevTools Protocol (CDP) messages.
 * Enables intercepting and forwarding CDP messages between a client and browser.
 *
 * The proxy maintains a connection state machine:
 * - INITIALIZED: Initial state, ready for connection
 * - CONNECTING: Connection attempt in progress
 * - CONNECTED: Successfully connected and proxying messages
 * - CLOSED: Connection closed, proxy cannot be reused
 *
 * Error handling:
 * - Connection timeout after 5 seconds
 * - Automatic cleanup on connection errors
 * - Message parsing errors are skipped
 * - Stream errors trigger proxy closure
 *
 * @example
 * ```typescript
 * // When you have a WebSocket from your client
 * const clientSocket = await acceptClientConnection();
 *
 * // Create manager and connect to browser
 * const manager = new WebSocketManager(
 *   clientSocket,
 *   (message: CDPRequest) => console.log('Client message:', message),
 *   (message: CDPResponse) => console.log('Browser message:', message)
 * );
 * await manager.connect(debuggerUrl, firstMessage);
 * await manager.sendToBrowser({ method: 'Page.navigate', params: { url: 'https://example.com' }});
 * await manager.sendToClient({ id: 1, result: {} });
 * ```
 */

import type { CDPRequest, CDPResponse, CDPEvent, CDPMessage } from './types.ts'

type MessageHandler = (message: CDPMessage) => void | Promise<void>

/**
 * Wraps a WebSocket to provide ReadableStream and WritableStream interfaces.
 * Handles binary data conversion and error propagation.
 */
class WebSocketStream {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

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

/**
 * Connection states for the WebSocket manager
 */
enum ConnectionState {
  INITIALIZED = 'initialized',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  CLOSED = 'closed',
}

/**
 * Manages bidirectional WebSocket connections for Chrome DevTools Protocol.
 * Handles message forwarding between a client and browser while allowing
 * message inspection and modification.
 */
export class WebSocketManager {
  private connectionState = ConnectionState.INITIALIZED
  private readonly clientSocket: WebSocket
  private browserSocket?: WebSocket
  private readonly onClientMessage?: MessageHandler
  private readonly onBrowserMessage?: MessageHandler

  private clientStream?: WebSocketStream
  private browserStream?: WebSocketStream

  private clientReader?: ReadableStreamDefaultReader<Uint8Array>
  private clientWriter?: WritableStreamDefaultWriter<Uint8Array>
  private browserReader?: ReadableStreamDefaultReader<Uint8Array>
  private browserWriter?: WritableStreamDefaultWriter<Uint8Array>

  constructor(
    clientSocket: WebSocket,
    onClientMessage?: MessageHandler,
    onBrowserMessage?: MessageHandler,
  ) {
    this.clientSocket = clientSocket
    this.onClientMessage = onClientMessage
    this.onBrowserMessage = onBrowserMessage
  }

  /**
   * Sends a message to the browser over the proxy connection
   * @throws {Error} If the proxy is not connected
   */
  public async sendToBrowser(message: CDPRequest) {
    if (this.connectionState !== ConnectionState.CONNECTED) {
      throw new Error('Cannot send message: proxy is not connected')
    }
    const encoded = new TextEncoder().encode(JSON.stringify(message))
    await this.browserWriter?.write(encoded)
  }

  /**
   * Sends a message to the client over the proxy connection
   * @throws {Error} If the proxy is not connected
   */
  public async sendToClient(message: CDPResponse | CDPEvent) {
    if (this.connectionState !== ConnectionState.CONNECTED) {
      throw new Error('Cannot send message: proxy is not connected')
    }
    const encoded = new TextEncoder().encode(JSON.stringify(message))
    await this.clientWriter?.write(encoded)
  }

  /**
   * Closes all active connections and cleans up resources.
   * This should be called when the proxy is no longer needed.
   */
  public async close() {
    if (this.connectionState === ConnectionState.CLOSED) return

    // Release stream readers and writers
    await this.clientReader?.cancel()
    await this.browserReader?.cancel()
    await this.clientWriter?.close()
    await this.browserWriter?.close()

    // Close WebSocket connections
    this.clientSocket.close()
    this.browserSocket?.close()

    // Clear references
    this.clientReader = undefined
    this.clientWriter = undefined
    this.browserReader = undefined
    this.browserWriter = undefined
    this.clientStream = undefined
    this.browserStream = undefined
    this.browserSocket = undefined

    this.connectionState = ConnectionState.CLOSED
  }

  /**
   * Establishes a connection to Chrome DevTools and starts proxying messages
   * between the client and browser.
   * @throws {Error} If the proxy is closed or already connected/connecting
   */
  public async connect(
    browserWebSocketDebuggerUrl: string,
    firstMessage: CDPRequest,
  ) {
    switch (this.connectionState) {
      case ConnectionState.CLOSED:
        throw new Error('Cannot connect: proxy has been closed')
      case ConnectionState.CONNECTED:
        throw new Error('Cannot connect: proxy is already connected')
      case ConnectionState.CONNECTING:
        throw new Error('Cannot connect: proxy is already connecting')
      case ConnectionState.INITIALIZED:
        break
    }

    this.connectionState = ConnectionState.CONNECTING

    try {
      this.browserSocket = await this.connectToBrowser(
        browserWebSocketDebuggerUrl,
      )

      this.clientStream = new WebSocketStream(this.clientSocket)
      this.browserStream = new WebSocketStream(this.browserSocket)

      this.clientReader = this.clientStream.readable.getReader()
      this.clientWriter = this.clientStream.writable.getWriter()
      this.browserReader = this.browserStream.readable.getReader()
      this.browserWriter = this.browserStream.writable.getWriter()

      // Start message piping with Promise.all to handle errors
      const pipePromises = [
        this.pipeMessages(
          this.clientReader,
          this.browserWriter,
          'clientToBrowser',
        ),
        this.pipeMessages(
          this.browserReader,
          this.clientWriter,
          'browserToClient',
        ),
      ]

      this.connectionState = ConnectionState.CONNECTED

      // Send first message after connection is established
      await this.sendToBrowser(firstMessage)

      // Handle pipe promises in background
      Promise.all(pipePromises).catch((error) => {
        console.error('Error in message piping:', error)
        this.close().catch(console.error)
      })
    } finally {
      if (this.connectionState === ConnectionState.CONNECTING) {
        this.connectionState = ConnectionState.CLOSED
      }
    }
  }

  /**
   * Connects to Chrome DevTools debugging endpoint.
   * @returns Promise resolving to the browser WebSocket connection
   */
  private async connectToBrowser(
    browserWebSocketDebuggerUrl: string,
  ): Promise<WebSocket> {
    const socket = new WebSocket(browserWebSocketDebuggerUrl)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close()
        reject(new Error('Connection timeout'))
      }, 5000)

      socket.onopen = () => {
        clearTimeout(timeout)
        resolve(socket)
      }

      socket.onclose = () => {
        clearTimeout(timeout)
        reject(new Error('Connection closed before established'))
      }

      socket.onerror = (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    })
  }

  /**
   * Pipes messages between a reader and writer stream, handling message parsing
   * and forwarding. Automatically cleans up the active session on completion.
   */
  private async pipeMessages(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    direction: 'clientToBrowser' | 'browserToClient',
  ) {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        this.connectionState = ConnectionState.CLOSED
        break
      }

      const messageText = new TextDecoder().decode(value)
      let parsed: CDPMessage
      try {
        parsed = JSON.parse(messageText)

        // Call appropriate message handler
        if (direction === 'clientToBrowser') {
          await this.onClientMessage?.(parsed)
        } else {
          await this.onBrowserMessage?.(parsed)
        }
      } catch {
        continue
      }

      await writer.write(value)
    }
    writer.close()
  }
}
