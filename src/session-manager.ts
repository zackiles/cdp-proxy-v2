/**
 * @module session-manager
 * @description Lean session registry (§4). A session = one automated website:
 * the unit of isolation and plugin configuration. Maps an opaque `sessionToken`
 * to its plugin set + isolation mode, enforces a concurrency ceiling, and tracks
 * live connection counts for teardown/observability. Distinct from CDP
 * `sessionId` and proxy `connectionId`.
 */

import type {
  Constraint,
  Draw,
  IsolationMode,
  LaunchSpec,
  PluginSet,
  SessionToken,
} from './types.ts'

export interface SessionRecord {
  token: SessionToken
  /** The session's plugin set, already flattened and grouped by kind. */
  plugins: PluginSet
  /**
   * The identity the loader chain drew for this session, still a candidate: it
   * is reconciled against the browser that actually starts and sealed at the
   * connection (§2.6). Absent for `plugins: 'none'`, which claims nothing.
   */
  profile?: Draw
  /** What was asked of the loaders, kept for the trace and for pool matching. */
  constraint: Constraint
  /** How the session's own process was started; absent on a pooled slot (§3.3). */
  launch?: LaunchSpec
  /** Profile fields the `launch` plugins read, for the coverage report (§2.8). */
  reads?: Record<string, string[]>
  /** What `onStart` corrected about the drawn identity, for the trace (§3.2). */
  corrections: string[]
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
  /**
   * A session went away: expired without ever connecting, or its last
   * connection closed. Whatever was reserved for it is now nobody's.
   */
  onRelease?: (token: SessionToken) => void
}

export class SessionManager {
  readonly #sessions = new Map<SessionToken, SessionRecord>()
  readonly #defaultIsolation: IsolationMode
  readonly #maxConcurrent: number
  readonly #tokenTtlMs: number
  readonly #onRelease?: (token: SessionToken) => void
  #active = 0

  constructor(options: SessionManagerOptions) {
    this.#defaultIsolation = options.defaultIsolation
    this.#maxConcurrent = options.maxConcurrent ?? 100
    this.#tokenTtlMs = options.tokenTtlMs ?? 5 * 60_000
    this.#onRelease = options.onRelease
  }

  /**
   * Drop a session and tell whoever is holding resources for it.
   *
   * DANGER: registering can start a browser process — an isolated session gets
   * one before its client's first message, deliberately (§3.3). Forgetting the
   * record without saying so leaves that process running for the life of the
   * proxy, which is how a fleet ends up with more Chromes than sessions.
   */
  #forget(rec: SessionRecord): void {
    this.#sessions.delete(rec.token)
    this.#onRelease?.(rec.token)
  }

  /**
   * Register a plugin set and receive a short-lived token to connect with. A
   * token that is never connected expires after `tokenTtlMs`, so an automator
   * that registers and then dies cannot leak plugin sets into the registry.
   */
  register(
    plugins: PluginSet,
    isolation: IsolationMode = this.#defaultIsolation,
    debug?: string,
    identity: { profile?: Draw; constraint?: Constraint } = {},
  ): SessionToken {
    for (const rec of this.#sessions.values()) {
      if (this.#expired(rec)) this.#forget(rec)
    }

    const token = crypto.randomUUID()
    this.#sessions.set(token, {
      token,
      plugins,
      profile: identity.profile,
      constraint: identity.constraint ?? {},
      corrections: [],
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
      this.#forget(rec)
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
    if (rec.connections === 0) this.#forget(rec)
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
