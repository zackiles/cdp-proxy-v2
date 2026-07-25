/**
 * @module session-manager
 * @description Lean session registry (§4). A session = one automated website:
 * the unit of isolation and plugin configuration. Maps an opaque `sessionToken`
 * to its plugin set + isolation mode, enforces a concurrency ceiling, and tracks
 * live connection counts for teardown/observability. Distinct from CDP
 * `sessionId` and proxy `connectionId`.
 */

import type { ConfiguredPlugin, IsolationMode, SessionToken } from './types.ts'

export interface SessionRecord {
  token: SessionToken
  plugins: ConfiguredPlugin[]
  isolation: IsolationMode
  /** Trace filter for this session only; falls back to `CDP_DEBUG` when absent. */
  debug?: string
  createdAt: number
  connections: number
}

export interface SessionManagerOptions {
  defaultIsolation: IsolationMode
  maxConcurrent?: number
  /** How long an issued token stays usable before its first connection. */
  tokenTtlMs?: number
}

export class SessionManager {
  readonly #sessions = new Map<SessionToken, SessionRecord>()
  readonly #defaultIsolation: IsolationMode
  readonly #maxConcurrent: number
  readonly #tokenTtlMs: number
  #active = 0

  constructor(options: SessionManagerOptions) {
    this.#defaultIsolation = options.defaultIsolation
    this.#maxConcurrent = options.maxConcurrent ?? 100
    this.#tokenTtlMs = options.tokenTtlMs ?? 5 * 60_000
  }

  /**
   * Register a plugin set and receive a short-lived token to connect with. A
   * token that is never connected expires after `tokenTtlMs`, so an automator
   * that registers and then dies cannot leak plugin sets into the registry.
   */
  register(
    plugins: ConfiguredPlugin[],
    isolation: IsolationMode = this.#defaultIsolation,
    debug?: string,
  ): SessionToken {
    for (const rec of this.#sessions.values()) {
      if (this.#expired(rec)) this.#sessions.delete(rec.token)
    }

    const token = crypto.randomUUID()
    this.#sessions.set(token, {
      token,
      plugins,
      isolation,
      debug,
      createdAt: Date.now(),
      connections: 0,
    })
    return token
  }

  resolve(token: SessionToken | null | undefined): SessionRecord | undefined {
    const rec = token ? this.#sessions.get(token) : undefined
    if (!rec) return undefined
    if (this.#expired(rec)) {
      this.#sessions.delete(rec.token)
      return undefined
    }
    return rec
  }

  /** Claim a connection slot. False if the token is unusable or we're at capacity. */
  acquire(token: SessionToken): boolean {
    const rec = this.resolve(token)
    if (!rec || this.#active >= this.#maxConcurrent) return false
    rec.connections++
    this.#active++
    return true
  }

  /** Release a slot claimed by {@link acquire}, reaping the session when idle. */
  release(token: SessionToken | null | undefined): void {
    const rec = token ? this.#sessions.get(token) : undefined
    if (!rec) return
    this.#active = Math.max(0, this.#active - 1)
    rec.connections = Math.max(0, rec.connections - 1)
    if (rec.connections === 0) this.#sessions.delete(rec.token)
  }

  #expired(rec: SessionRecord): boolean {
    return rec.connections === 0 &&
      Date.now() - rec.createdAt > this.#tokenTtlMs
  }

  get active(): number {
    return this.#active
  }

  get atCapacity(): boolean {
    return this.#active >= this.#maxConcurrent
  }
}
