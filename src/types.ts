import type { WebSocketStream } from './websocket-connection.ts'
type TargetId = string
type SessionId = string
type ConnectionId = string

interface CDPTarget {
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

interface ProxyConnection {
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

type CDPMessage = CDPRequest | CDPResponse | CDPEvent

interface CDPError {
  type: 'connection' | 'protocol' | 'validation' | 'resource' | 'plugin'
  code: number
  message: string
  details?: unknown
  recoverable: boolean
}

interface CDPRequest {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

interface CDPResponse {
  id: number
  result?: Record<string, unknown>
  error?: CDPError
  sessionId?: string
}

interface CDPEvent {
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

interface CDPPlugin {
  name: string
  sendCommand?: (sessionId: string, message: CDPRequest) => Promise<CDPResponse>
  emitEvent?: (sessionId: string, event: CDPEvent) => Promise<void>
  onRequest?: (request: CDPRequest) => Promise<CDPRequest | null>
  onResponse?: (response: CDPResponse) => Promise<CDPResponse | null>
  onEvent?: (event: CDPEvent) => Promise<CDPEvent | null>
  cleanup?: () => Promise<void>
}

interface EnvVars {
  CDP_PROXY_PORT?: string
  CDP_PROXY_HOST?: string
  CDP_BROWSER_PORT?: string
  CDP_BROWSER_HOST?: string
  CDP_BROWSER_DIRECTORY?: string
  CDP_BROWSER_VERSION?: string
  CDP_BROWSER_EXECUTABLE_PATH?: string
  CDP_PROXY_LOG_LEVEL?: string
  CDP_PROXY_LOG_TAGS?: string
}

export type {
  TargetId,
  SessionId,
  ConnectionId,
  CDPTarget,
  ProxyConnection,
  CDPMessage,
  CDPError,
  CDPRequest,
  CDPResponse,
  CDPEvent,
  CDPPlugin,
  EnvVars,
}
