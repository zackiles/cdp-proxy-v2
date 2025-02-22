import { WebSocketStream } from ''
import type {
  ProxyManager as IProxyManager,
  ProxyConnection,
  CDPTarget,
  ConnectionId,
  SessionId,
  TargetId,
  CDPRequest,
  CDPResponse,
} from './types.ts'
type TargetSearchParams =
  | { sessionId: SessionId; targetId?: never; connectionId?: ConnectionId }
  | { sessionId?: never; targetId: TargetId; connectionId?: ConnectionId }

export class ProxyManager implements IProxyManager {
  connections: Map<ConnectionId, ProxyConnection> = new Map()

  constructor() {}

  async getTarget(params: TargetSearchParams): Promise<CDPTarget | undefined> {
    const connection = params.connectionId
      ? this.connections.get(params.connectionId)
      : Array.from(this.connections.values())[0]

    if (!connection) return undefined

    if (params.sessionId) {
      return Array.from(connection.targets.values()).find(
        (target) => target.sessionId === params.sessionId,
      )
    }

    if (params.targetId) {
      return connection.targets.get(params.targetId)
    }

    return undefined
  }

  async interceptClientMessage(
    connectionId: ConnectionId,
    message: CDPRequest,
  ): Promise<CDPRequest> {
    // Default implementation passes through the message
    return message
  }

  async interceptBrowserMessage(
    connectionId: ConnectionId,
    message: CDPResponse,
  ): Promise<CDPResponse> {
    // Default implementation passes through the message
    return message
  }

  async forwardToBrowser(
    connectionId: ConnectionId,
    message: CDPRequest,
  ): Promise<void> {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      throw new Error(`No connection found for id: ${connectionId}`)
    }

    // Implementation would send the message through browserWebsocketStream
    // Exact implementation depends on WebSocketStream interface
  }

  async forwardToClient(
    connectionId: ConnectionId,
    message: CDPResponse,
  ): Promise<void> {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      throw new Error(`No connection found for id: ${connectionId}`)
    }

    // Implementation would send the message through clientWebsocketStream
    // Exact implementation depends on WebSocketStream interface
  }

  async createConnection(browserWebSocketDebuggerUrl: string): Promise<void> {
    // Implementation would:
    // 1. Create a new connection ID
    // 2. Establish WebSocket connections
    // 3. Create ProxyConnection object
    // 4. Add to connections map
  }

  async closeConnection(connectionId: ConnectionId): Promise<void> {
    const connection = this.connections.get(connectionId)
    if (!connection) return

    // Close websocket streams
    // Remove from connections map
    this.connections.delete(connectionId)
  }

  async close(): Promise<void> {
    // Close all connections
    for (const connectionId of this.connections.keys()) {
      await this.closeConnection(connectionId)
    }
  }
}
