export type TargetId = string
export type SessionId = string

export type ConnectionId = string

export interface CDPTarget {
  sessionId: SessionId
  targetId: TargetId
  type:
    | 'tab'
    | 'page'
    | 'iframe'
    | 'worker'
    | 'shared_worker'
    | 'service_worker'
    | 'worklet'
    | 'shared_storage_worklet'
    | 'browser'
    | 'webview'
    | 'auction_worklet'
    | 'assistive_technology'
}

export interface ProxyConnection {
  /** UUID for a proxy connection. Can only be used to represent one client to one browser.
   *  example: "b0b8a4fb-bb17-4359-9533-a8d9f3908bd8"
   */
  connectionId: ConnectionId
  /** The WebSocket URL of the real browser CDP endpoint
   *  example: "ws://localhost:9222/devtools/browser/b0b8a4fb-bb17-4359-9533-a8d9f3908bd8"
   */
  browserWebSocketDebuggerUrl: string
  clientWebsocketStream: WebSocketStream
  browserWebsocketStream: WebSocketStream

  targets: Map<TargetId, CDPTarget>
}

export interface ProxyManager {
  connections: Map<ConnectionId, ProxyConnection>
  getTarget(params: TargetSearchParams): Promise<CDPTarget | undefined>

  interceptClientMessage(
    connectionId: ConnectionId,
    message: CDPRequest,
  ): Promise<CDPRequest>

  interceptBrowserMessage(
    connectionId: ConnectionId,
    message: CDPResponse,
  ): Promise<CDPResponse>

  forwardToBrowser(
    connectionId: ConnectionId,
    message: CDPRequest,
  ): Promise<void>
  forwardToClient(
    connectionId: ConnectionId,
    message: CDPResponse,
  ): Promise<void>

  createConnection(browserWebSocketDebuggerUrl: string): Promise<void>

  closeConnection(connectionId: ConnectionId): Promise<void>

  close(): Promise<void>
}

type CDPMessage = CDPRequest | CDPResponse | CDPEvent

export interface CDPError {
  type: 'connection' | 'protocol' | 'validation' | 'resource' | 'plugin'
  code: number
  message: string
  details?: unknown
  recoverable: boolean
}

export interface CDPRequest {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

export interface CDPResponse {
  id: number
  result?: Record<string, unknown>
  error?: CDPError
  sessionId?: string
}

export interface CDPEvent {
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

export interface CDPPlugin {
  name: string
  sendCommand?: (sessionId: string, message: CDPRequest) => Promise<CDPResponse>
  emitEvent?: (sessionId: string, event: CDPEvent) => Promise<void>
  onRequest?: (request: CDPRequest) => Promise<CDPRequest | null>
  onResponse?: (response: CDPResponse) => Promise<CDPResponse | null>
  onEvent?: (event: CDPEvent) => Promise<CDPEvent | null>
  cleanup?: () => Promise<void>
}
