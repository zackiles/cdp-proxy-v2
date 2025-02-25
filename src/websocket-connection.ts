/**
 * @module websocket-connection
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
 * const manager = new WebSocketConnection(
 *   clientSocket,
 *   (message: CDPRequest) => console.log('Client message:', message),
 *   (message: CDPResponse) => console.log('Browser message:', message)
 * );
 * await manager.connect(debuggerUrl, firstMessage);
 * await manager.sendToBrowser({ method: 'Page.navigate', params: { url: 'https://example.com' }});
 * await manager.sendToClient({ id: 1, result: {} });
 * ```
 */

import type { CDPRequest, CDPResponse, CDPEvent } from './types.ts'

type WebSocketMessageHandler = (
  message: CDPRequest | CDPResponse | CDPEvent,
) => void | Promise<void>

/**
 * Represents a WebSocket endpoint with its associated streams and handlers
 */
interface WebSocketEndpoint {
  socket: WebSocket | undefined
  stream: WebSocketStream | undefined
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  writer: WritableStreamDefaultWriter<Uint8Array> | undefined
}

/**
 * Wraps a WebSocket to provide ReadableStream and WritableStream interfaces.
 * Handles binary data conversion and error propagation.
 */
export class WebSocketStream {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null

  constructor(socket: WebSocket) {
    this.readable = new ReadableStream({
      start: (controller) => {
        this.controller = controller // Store controller reference

        socket.onmessage = (event) => {
          if (event.data instanceof Blob) {
            event.data.arrayBuffer().then((buffer) => {
              if (this.controller) {
                // Check controller exists
                this.controller.enqueue(new Uint8Array(buffer))
              }
            })
          } else if (event.data instanceof ArrayBuffer) {
            if (this.controller) {
              // Check controller exists
              this.controller.enqueue(new Uint8Array(event.data))
            }
          }
        }

        socket.onclose = () => {
          if (this.controller) {
            // Only close if controller exists
            this.controller.close()
            this.controller = null // Clear reference
          }
        }

        socket.onerror = (err) => {
          if (this.controller) {
            // Check controller exists
            this.controller.error(err)
            this.controller = null // Clear reference
          }
        }
      },
      cancel: () => {
        if (this.controller) {
          this.controller = null // Clear reference
        }
      },
    })

    this.writable = new WritableStream({
      write(chunk) {
        if (socket.readyState === socket.OPEN) {
          socket.send(chunk)
        }
      },
      close() {
        // Only close if socket is still open
        if (socket.readyState === socket.OPEN) {
          socket.close()
        }
      },
    })
  }
}

/**
 * Connection states for the WebSocket manager
 */
enum WebSocketConnectionState {
  INITIALIZED = 'initialized',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  CLOSED = 'closed',
}

/**
 * An instance of a 1:1 WebSocket connection between a client and a browser's root
 * weDebuggerUrl endpoint. Handles message forwarding between a client and browser while
 * allowing message inspection and modification. Instances are created and managed by
 * the ProxyAgent internally.
 */
class WebSocketConnection {
  private connectionState = WebSocketConnectionState.INITIALIZED
  private readonly onClientMessage?: WebSocketMessageHandler
  private readonly onBrowserMessage?: WebSocketMessageHandler

  private client: WebSocketEndpoint = {
    socket: undefined,
    stream: undefined,
    reader: undefined,
    writer: undefined,
  }

  private browser: WebSocketEndpoint = {
    socket: undefined,
    stream: undefined,
    reader: undefined,
    writer: undefined,
  }

  constructor(
    clientSocket: WebSocket,
    onClientMessage?: WebSocketMessageHandler,
    onBrowserMessage?: WebSocketMessageHandler,
  ) {
    this.client.socket = clientSocket
    this.onClientMessage = onClientMessage
    this.onBrowserMessage = onBrowserMessage
  }

  /**
   * Sends a message to the browser over the proxy connection
   * @throws {Error} If the proxy is not connected
   */
  public async sendToBrowser(message: CDPRequest) {
    if (this.connectionState !== WebSocketConnectionState.CONNECTED) {
      throw new Error('Cannot send message: proxy is not connected')
    }
    const encoded = new TextEncoder().encode(JSON.stringify(message))

    await this.browser.writer?.write(encoded)
  }

  /**
   * Sends a message to the client over the proxy connection
   * @throws {Error} If the proxy is not connected
   */
  public async sendToClient(message: CDPResponse | CDPEvent) {
    if (this.connectionState !== WebSocketConnectionState.CONNECTED) {
      throw new Error('Cannot send message: proxy is not connected')
    }
    const encoded = new TextEncoder().encode(JSON.stringify(message))
    await this.client.writer?.write(encoded)
  }

  /**
   * Closes all active connections and cleans up resources.
   * This should be called when the proxy is no longer needed.
   */
  public async close() {
    if (this.connectionState === WebSocketConnectionState.CLOSED) return

    // Release stream readers and writers
    await this.client.reader?.cancel()
    await this.browser.reader?.cancel()
    await this.client.writer?.close()
    await this.browser.writer?.close()

    // Close WebSocket connections
    this.client.socket?.close()
    this.browser.socket?.close()

    // Clear references
    this.client = {
      socket: undefined,
      stream: undefined,
      reader: undefined,
      writer: undefined,
    }
    this.browser = {
      socket: undefined,
      stream: undefined,
      reader: undefined,
      writer: undefined,
    }

    this.connectionState = WebSocketConnectionState.CLOSED
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
      case WebSocketConnectionState.CLOSED:
        throw new Error('Cannot connect: proxy has been closed')
      case WebSocketConnectionState.CONNECTED:
        throw new Error('Cannot connect: proxy is already connected')
      case WebSocketConnectionState.CONNECTING:
        throw new Error('Cannot connect: proxy is already connecting')
      case WebSocketConnectionState.INITIALIZED:
        break
    }

    this.connectionState = WebSocketConnectionState.CONNECTING

    try {
      this.browser.socket = await this.connectToBrowser(
        browserWebSocketDebuggerUrl,
      )

      if (!this.client.socket) {
        throw new Error('Client socket is not initialized')
      }
      this.client.stream = new WebSocketStream(this.client.socket)
      this.browser.stream = new WebSocketStream(this.browser.socket)

      this.client.reader = this.client.stream.readable.getReader()
      this.client.writer = this.client.stream.writable.getWriter()
      this.browser.reader = this.browser.stream.readable.getReader()
      this.browser.writer = this.browser.stream.writable.getWriter()

      // Start message piping with Promise.all to handle errors
      const pipePromises = [
        this.pipeMessages(
          this.client.reader,
          this.browser.writer,
          'clientToBrowser',
        ),
        this.pipeMessages(
          this.browser.reader,
          this.client.writer,
          'browserToClient',
        ),
      ]

      this.connectionState = WebSocketConnectionState.CONNECTED

      // Send first message after connection is established
      await this.sendToBrowser(firstMessage)

      // Handle pipe promises in background
      Promise.all(pipePromises).catch((error) => {
        console.error('Error in message piping:', error)
        this.close().catch(console.error)
      })
    } finally {
      if (this.connectionState === WebSocketConnectionState.CONNECTING) {
        this.connectionState = WebSocketConnectionState.CLOSED
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
    const abortController = new AbortController()

    // Set up timeout
    const timeoutId = setTimeout(() => {
      abortController.abort()
      socket.close()
    }, 5000)

    try {
      await new Promise<void>((resolve, reject) => {
        // Use AbortController signal to handle timeout
        abortController.signal.addEventListener('abort', () => {
          reject(new Error('Connection timeout'))
        })

        socket.onopen = () => resolve()
        socket.onclose = () =>
          reject(new Error('Connection closed before established'))
        socket.onerror = (error) => reject(error)
      })

      return socket
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Pipes messages between a reader and writer stream, handling message parsing
   * and forwarding. Automatically cleans up the active session on completion.
   * @throws {Error} If message handling fails in an unrecoverable way
   */
  private async pipeMessages(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    direction: 'clientToBrowser' | 'browserToClient',
  ): Promise<void> {
    const decoder = new TextDecoder()
    const messageHandler =
      direction === 'clientToBrowser'
        ? this.onClientMessage
        : this.onBrowserMessage

    try {
      while (true) {
        const { value, done } = await reader.read()

        if (done) {
          this.connectionState = WebSocketConnectionState.CLOSED
          break
        }

        // Process message if we have a value
        if (value) {
          const messageText = decoder.decode(value)

          // Handle the message and continue even if parsing fails
          await this.handleMessage(messageText, messageHandler).catch((error) =>
            console.error('Message handling error:', error),
          )

          // Always forward the raw message regardless of parsing success
          await writer.write(value)
        }
      }
    } catch (error) {
      console.error('Fatal error in message pipe:', error)
      throw error
    } finally {
      await writer.close().catch(() => {}) // Ignore close errors
    }
  }

  /**
   * Handles parsing and processing of a single message
   * @param messageText - The raw message text to parse
   * @param handler - The message handler to call if parsing succeeds
   */
  private async handleMessage(
    messageText: string,
    handler?: WebSocketMessageHandler,
  ): Promise<void> {
    try {
      const parsed = JSON.parse(messageText) as
        | CDPRequest
        | CDPResponse
        | CDPEvent
      await handler?.(parsed)
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.warn('Failed to parse message:', error)
      } else {
        throw error // Rethrow non-parsing errors
      }
    }
  }
}

export { WebSocketConnection }
