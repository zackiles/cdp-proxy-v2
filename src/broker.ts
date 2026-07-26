/**
 * @module broker
 * @description One owner for the CDP domains that only have room for one (§7.2).
 *
 * Four commands on the protocol are *whole-state* rather than additive: calling
 * one replaces whatever the last caller set, with no error and no sign that
 * anything was lost.
 *
 * | Command                              | What the second caller destroys              |
 * | ------------------------------------ | -------------------------------------------- |
 * | `Fetch.enable`                       | The first caller's `patterns` array.         |
 * | `Network.setExtraHTTPHeaders`        | The first caller's entire header map.        |
 * | `Target.setAutoAttach`               | The first caller's settings, browser-wide.   |
 * | `Emulation.setDeviceMetricsOverride` | The first caller's metrics struct.           |
 *
 * `Browser.setWindowBounds` and `Emulation.clearDeviceMetricsOverride` are here
 * too, as the other half of the display claim rather than as domains of their
 * own: the window's height and the monitor behind it are one story, and a client
 * clearing its viewport must not take the monitor down with it.
 *
 * Left alone, this makes the last plugin to call win, silently — and since the
 * *client* is also a caller, "last" is a race between Playwright's own startup
 * and the pipeline. The broker replaces that race with a rule: nobody calls
 * these directly. Everyone declares what they want, the broker unions the
 * declarations, makes one call, and dispatches what comes back to whoever
 * matched. Overlaps are resolved by priority and named in the trace at session
 * start, so two plugins fighting is a line of output rather than a mystery.
 *
 * ## The client is a participant, not an exception
 *
 * The interesting half of this is that the *client's* calls go through the same
 * merge. Playwright sets extra headers when a caller passes `extraHTTPHeaders`,
 * enables `Fetch` for `page.route()`, and sets auto-attach on every page — all
 * without knowing the platform exists. Each of those is intercepted, folded into
 * the union, and answered as though it had been forwarded, which is why
 * `page.route()` and a surface's `Accept-Language` can both be in effect at once
 * when neither knows about the other.
 *
 * DANGER: the broker answers intercepted commands with `{ respond }` rather than
 * refusing them. A refusal would surface to the caller as a protocol error on a
 * command they were entitled to send; the point is that it keeps working, not
 * that it is forbidden. Only `actor`'s escape hatch refuses outright (§6.4), and
 * that is because an actor is platform code that has a declarative route.
 */

import type { Protocol } from 'devtools-protocol/types/protocol.d.ts'
import type {
  CDPEvent,
  CDPRequest,
  CDPTarget,
  Display,
  Send,
  SessionId,
  TargetId,
} from './types.ts'
import type { Debug } from './debug.ts'
import { asError } from './utils.ts'

/**
 * The commands the broker owns. `actor`'s escape hatch refuses these by name and
 * points at the declarative route instead (§6.4), so the list and its reasons
 * live here rather than being written out twice.
 */
export const BROKERED: Record<string, string> = {
  'Fetch.enable': 'the broker unions interception patterns; a direct call ' +
    "replaces everyone else's",
  'Network.setExtraHTTPHeaders':
    'contribute `headers` from a surface (§4.3) — the broker merges them, a ' +
    'direct call replaces the whole map',
  'Target.setAutoAttach':
    'the setting is browser-wide and shared with the client; declare the ' +
    'realms you need instead (§4.4)',
  'Emulation.setDeviceMetricsOverride':
    'the struct is whole-state; contribute `display` from a surface (§4.3) — ' +
    "the broker folds it into the client's own call",
}

/** One `Fetch.enable` interception pattern, as the protocol defines it. */
type Pattern = Protocol.Fetch.RequestPattern

/** A header contribution and who made it, so a loser can be named. */
interface Claim {
  by: string
  priority: number
  value: string
}

export interface BrokerWire {
  send: Send
  /** Push an event at the client as though the browser had sent it. */
  emit(evt: CDPEvent): void
  /** Answer a client request the broker intercepted. */
  respond(id: number, sessionId: SessionId | undefined, result: unknown): void
}

/**
 * Per-connection arbitration over the four whole-state domains.
 *
 * Instantiated by `ProxyConnection`, which routes client requests through
 * {@link request} and browser events through {@link event} before either reaches
 * the pipeline.
 */
export class Broker {
  readonly #wire: BrokerWire
  readonly #debug?: Debug

  /** Header claims by name, highest priority winning (§9.5). */
  readonly #headers = new Map<string, Claim>()
  /** What the client asked for, per session, folded in under every claim. */
  readonly #clientHeaders = new Map<SessionId, Record<string, string>>()
  /** Sessions the merged set has been pushed to, so a change can re-push. */
  readonly #headed = new Set<SessionId>()

  /** `Fetch` interception patterns by claimant. */
  readonly #patterns = new Map<string, Pattern[]>()
  /** Sessions where the client wants `Fetch.requestPaused` delivered. */
  readonly #fetchClients = new Set<SessionId>()
  #credentials: { username: string; password: string } | undefined
  #fetching = false

  /** The monitor and window chrome a surface claimed, if one did. */
  #display: Display | undefined
  /** Which target each session belongs to, since a metrics override is per target. */
  readonly #targets = new Map<SessionId, TargetId>()
  /** Targets whose viewport the client set, and targets the broker claimed alone. */
  readonly #viewports = new Set<TargetId>()
  readonly #claimed = new Set<TargetId>()

  /** Whether the runtime needs targets paused at start for realm delivery. */
  #pausing = false
  /** Sessions where the client asked for the pause and will resume it itself. */
  readonly #clientPauses = new Set<SessionId>()

  constructor(wire: BrokerWire, debug?: Debug) {
    this.#wire = wire
    this.#debug = debug
  }

  /**
   * Fold a set of surface headers into the merged map (§4.3).
   *
   * Called once per session with everything `compile` gathered, rather than once
   * per surface, because the surfaces have already been ordered and merged
   * against each other by then — the broker's job starts where theirs ends, at
   * the boundary with the client.
   */
  headers(by: string, headers: Record<string, string>, priority = 0): void {
    for (const [name, value] of Object.entries(headers)) {
      const held = this.#headers.get(name)
      if (held && held.priority >= priority) {
        if (held.value !== value) {
          this.#debug?.conflict(
            `${name}: ${by} wanted "${value}", ${held.by} holds "${held.value}"`,
          )
        }
        continue
      }
      if (held) {
        this.#debug?.conflict(
          `${name}: ${by} took it from ${held.by} on priority`,
        )
      }
      this.#headers.set(name, { by, priority, value })
    }
  }

  /**
   * Take on a surface's display claim (§4.3).
   *
   * The claim is applied two ways: folded into every
   * `Emulation.setDeviceMetricsOverride` the client sends, and — only for a page
   * whose viewport the client never claimed — sent alone once the page has a
   * document. Both are needed, because a caller passing `viewport: null` never
   * sends the command at all and would leave the monitor unclaimed.
   */
  display(by: string, claim: Display): void {
    if (!claim.screen && claim.chrome === undefined) return
    if (this.#display) {
      this.#debug?.conflict(`display: ${by} wanted it, and it is already held`)
      return
    }
    this.#display = claim
  }

  /** The credentials a `launch` plugin claimed, for `Fetch.authRequired` (§3.1). */
  auth(credentials: { username: string; password: string }): void {
    this.#credentials = credentials
    // Interception has to be on before the challenge arrives, and there is no
    // narrower pattern available: a proxy challenges whatever it likes.
    this.#patterns.set('auth', [{ urlPattern: '*' }])
  }

  /** Declare that realm delivery needs targets paused at start (§7.1). */
  pause(): void {
    this.#pausing = true
  }

  /**
   * Install everything declared so far on a newly attached target.
   *
   * Sending on attach rather than at session start is what makes the merge hold
   * for pages the client opens later: domain state is per-session, so a header
   * set installed on the first page means nothing to the second.
   */
  async attach(target: CDPTarget): Promise<void> {
    this.#targets.set(target.sessionId, target.targetId)
    await this.#pushHeaders(target.sessionId)
    await this.#pushFetch(target.sessionId)
  }

  /** Drop what a detached target was holding. */
  detach(sessionId: SessionId): void {
    this.#clientHeaders.delete(sessionId)
    this.#headed.delete(sessionId)
    this.#fetchClients.delete(sessionId)
    this.#clientPauses.delete(sessionId)
    const target = this.#targets.get(sessionId)
    this.#targets.delete(sessionId)
    // Only when no other session is still attached to it: a client opening a
    // second session on a page it already has does not give the viewport back.
    if (target && ![...this.#targets.values()].includes(target)) {
      this.#viewports.delete(target)
      this.#claimed.delete(target)
    }
  }

  /**
   * A page committed a document, which is the last honest moment to notice that
   * the client never asked for a viewport.
   *
   * DANGER: the claim cannot go out on attach, and the reason is not a race.
   * A metrics override belongs to the *target*, not the session, so a client
   * calling `newCDPSession()` on a page it already configured produces a second
   * attach — and a claim sent on that session replaces the viewport the client
   * set on the first one. Pushing only where the client never claimed a viewport
   * is what keeps `page.setViewportSize()` and the monitor from being the same
   * decision.
   */
  async document(sessionId: SessionId): Promise<void> {
    const target = this.#targets.get(sessionId)
    if (!target || this.#viewports.has(target)) return
    if (this.#claimed.has(target)) return
    this.#claimed.add(target)
    await this.#pushMetrics(sessionId)
  }

  /**
   * Intercept a client command in a brokered domain, or pass it through.
   *
   * Returns `true` when the broker answered it and the command must not be
   * forwarded.
   */
  async request(msg: CDPRequest): Promise<boolean> {
    const session = msg.sessionId
    switch (msg.method) {
      case 'Network.setExtraHTTPHeaders': {
        if (!session) return false
        const asked =
          (msg.params as { headers?: Record<string, string> })?.headers ?? {}
        this.#clientHeaders.set(session, asked)
        for (const name of Object.keys(asked)) {
          const held = this.#headers.get(name)
          if (held) {
            this.#debug?.conflict(
              `${name}: the client wanted "${asked[name]}", ${held.by} holds ` +
                `"${held.value}"`,
            )
          }
        }
        await this.#pushHeaders(session)
        this.#wire.respond(msg.id, session, {})
        return true
      }

      case 'Fetch.enable': {
        if (!session) return false
        const asked = msg.params as {
          patterns?: Pattern[]
          handleAuthRequests?: boolean
        }
        this.#fetchClients.add(session)
        // An absent `patterns` means every request, which unions to every
        // request — recording it as `[]` would union to nothing and silently
        // switch off the client's own interception.
        this.#patterns.set('client', asked?.patterns ?? [{ urlPattern: '*' }])
        await this.#pushFetch(session)
        this.#wire.respond(msg.id, session, {})
        return true
      }

      case 'Fetch.disable': {
        if (!session) return false
        this.#fetchClients.delete(session)
        this.#patterns.delete('client')
        // Not actually disabled if the broker still has a claim of its own: the
        // client is entitled to stop caring, not to switch off proxy auth.
        if (this.#patterns.size === 0) {
          this.#fetching = false
          return false
        }
        await this.#pushFetch(session)
        this.#wire.respond(msg.id, session, {})
        return true
      }

      case 'Emulation.setDeviceMetricsOverride': {
        // Rewritten in flight rather than answered, because the client's own
        // viewport is the half of the struct it is entitled to decide — and a
        // metrics override the page would have received anyway is the higher rung
        // of §4.2: no patched function on any prototype.
        const target = session && this.#targets.get(session)
        if (target) this.#viewports.add(target)
        const screen = this.#display?.screen
        if (screen && msg.params) {
          Object.assign(msg.params, {
            screenWidth: screen.width,
            screenHeight: screen.height,
            deviceScaleFactor: screen.scale,
          })
        }
        return false
      }

      case 'Emulation.clearDeviceMetricsOverride': {
        // The client is entitled to drop its viewport, and not to drop the
        // monitor with it: clearing takes the screen claim down too, so it goes
        // back on afterwards.
        if (!session || !this.#display?.screen) return false
        const target = this.#targets.get(session)
        if (target) this.#viewports.delete(target)
        await this.#wire.send(msg.method, undefined, session).catch(() => {})
        await this.#pushMetrics(session)
        this.#wire.respond(msg.id, session, {})
        return true
      }

      case 'Browser.setWindowBounds': {
        // Playwright sizes the window to the viewport exactly, leaving
        // `outerHeight === innerHeight` — a window with no tab strip and no
        // toolbar. Give those back the room they take up in a real one.
        const chrome = this.#display?.chrome
        const bounds = (msg.params as { bounds?: { height?: number } })?.bounds
        if (chrome !== undefined && bounds?.height !== undefined) {
          bounds.height += chrome
        }
        return false
      }

      case 'Target.setAutoAttach': {
        const asked = msg.params as {
          autoAttach?: boolean
          waitForDebuggerOnStart?: boolean
        }
        if (session && asked?.waitForDebuggerOnStart) {
          // The client wants the pause and will resume it, which is the case the
          // runtime rides on rather than duplicating.
          this.#clientPauses.add(session)
        }
        if (this.#pausing && asked && !asked.waitForDebuggerOnStart) {
          // Widened rather than refused: the client keeps the auto-attach it
          // asked for, and the runtime takes on resuming what it paused.
          this.#debug?.conflict(
            'Target.setAutoAttach: widened waitForDebuggerOnStart for realm ' +
              'delivery; the runtime resumes what the client did not pause',
          )
          msg.params = { ...asked, waitForDebuggerOnStart: true }
        }
        return false
      }

      default:
        return false
    }
  }

  /**
   * Handle a browser event in a brokered domain.
   *
   * Returns `true` when the broker consumed it and the client must not see it —
   * an auth challenge the client never asked for, or a paused request nobody
   * claimed.
   */
  async event(evt: CDPEvent): Promise<boolean> {
    if (evt.method === 'Fetch.authRequired') {
      const { requestId } = (evt.params ?? {}) as { requestId?: string }
      if (!requestId) return false
      // Answering `Default` rather than falling through matters: an unanswered
      // challenge stalls the request until Chrome gives up, and a client that
      // never enabled `Fetch` has nothing listening to answer it.
      const response = this.#credentials
        ? { response: 'ProvideCredentials' as const, ...this.#credentials }
        : { response: 'Default' as const }
      await this.#wire.send(
        'Fetch.continueWithAuth',
        { requestId, authChallengeResponse: response },
        evt.sessionId,
      ).catch((err) =>
        this.#debug?.conflict(
          `Fetch.continueWithAuth failed: ${asError(err).message}`,
        )
      )
      return true
    }

    if (evt.method === 'Fetch.requestPaused') {
      // The client owns the request if it asked for interception on this
      // session; otherwise the pause is the broker's own doing and continuing
      // it is the whole of the work.
      if (evt.sessionId && this.#fetchClients.has(evt.sessionId)) return false
      const { requestId } = (evt.params ?? {}) as { requestId?: string }
      if (!requestId) return false
      await this.#wire.send(
        'Fetch.continueRequest',
        { requestId },
        evt.sessionId,
      ).catch(() => {})
      return true
    }

    return false
  }

  /**
   * Resume a target the broker paused on the client's behalf.
   *
   * DANGER: only for targets the client did not ask to pause. Resuming one it
   * did would release the target before the client attached its own listeners,
   * losing events it was promised.
   */
  async resume(sessionId: SessionId, parent?: SessionId): Promise<void> {
    if (!this.#pausing) return
    if (parent && this.#clientPauses.has(parent)) return
    await this.#wire.send(
      'Runtime.runIfWaitingForDebugger',
      undefined,
      sessionId,
    ).catch(() => {})
  }

  /** What the merged header set comes to, for the trace and for tests. */
  get merged(): Record<string, string> {
    return Object.fromEntries(
      [...this.#headers].map(([name, claim]) => [name, claim.value]),
    )
  }

  /**
   * Claim the monitor without touching the viewport.
   *
   * DANGER: `width: 0, height: 0` is what "leave the viewport alone" is spelled
   * as, and it is load-bearing in both directions. Real numbers here would pin
   * the page to a size the caller never asked for; leaving `screenWidth` out
   * while sending zeroes drops the screen to Chrome's own 800×600 emulation
   * default, which is worse than the tell it was sent to fix.
   */
  async #pushMetrics(sessionId: SessionId): Promise<void> {
    const screen = this.#display?.screen
    if (!screen) return
    await this.#wire.send('Emulation.setDeviceMetricsOverride', {
      width: 0,
      height: 0,
      deviceScaleFactor: screen.scale,
      mobile: false,
      screenWidth: screen.width,
      screenHeight: screen.height,
    }, sessionId).catch((err) =>
      this.#debug?.conflict(`display rejected: ${asError(err).message}`)
    )
  }

  async #pushHeaders(sessionId: SessionId): Promise<void> {
    const client = this.#clientHeaders.get(sessionId) ?? {}
    // Claims last: a surface exists to make the browser's story coherent, and a
    // client that overrode `Accept-Language` without knowing about the profile
    // would be contradicting the identity the rest of the session presents.
    const merged = { ...client, ...this.merged }
    if (Object.keys(merged).length === 0) return
    await this.#wire.send('Network.enable', {}, sessionId).catch(() => {})
    await this.#wire.send(
      'Network.setExtraHTTPHeaders',
      { headers: merged },
      sessionId,
    ).then(() => void this.#headed.add(sessionId))
      .catch((err) =>
        this.#debug?.conflict(`headers rejected: ${asError(err).message}`)
      )
  }

  async #pushFetch(sessionId: SessionId): Promise<void> {
    if (this.#patterns.size === 0) return
    const patterns = [...this.#patterns.values()].flat()
    await this.#wire.send('Fetch.enable', {
      patterns,
      handleAuthRequests: this.#credentials !== undefined,
    }, sessionId).then(() => void (this.#fetching = true))
      .catch((err) =>
        this.#debug?.conflict(`Fetch.enable rejected: ${asError(err).message}`)
      )
  }
}
