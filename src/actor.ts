/**
 * @module actor
 * @description The imperative kind: watch a page, decide, act (§6).
 *
 * `actor` is a kind rather than a library over `protocol`, and the reason is not
 * stylistic. Two of its three properties are decisions about *instantiation and
 * scheduling*, which only the thing doing the instantiating and scheduling can
 * make:
 *
 * 1. **Its lifetime is one page.** `setup` runs per page target and its closure
 *    *is* that page's state. No `ctx.state`, no map keyed by session id, no
 *    pruning — the runtime drops the whole thing on detach.
 * 2. **It is off the message queue.** Every `protocol` hook runs inside the
 *    message path, which is why a slow one is latency and an await on another
 *    event is a deadlock. An actor's callbacks get their own task per page, so
 *    it can call a captcha solver over HTTP for ten seconds while the page's CDP
 *    traffic keeps flowing.
 * 3. **It gets a page handle.** `page.click('#submit')` rather than three
 *    `Input.dispatchMouseEvent` calls with coordinates it had to compute.
 *
 * A library could offer the third as helper functions. It could not offer the
 * first two, because a `protocol` plugin is instantiated once per connection and
 * its hooks run on the message path by definition.
 *
 * ## Why the input goes through the `Input` domain
 *
 * `element.click()` produces an event with `isTrusted: false`, which is a
 * one-line check and a well-known tell. Everything here dispatches through
 * `Input.*` instead, so the page sees events it cannot distinguish from a
 * user's. Delays between them are drawn from `profile.noise` rather than from
 * `Math.random`, so an actor's cadence belongs to the identity: two sessions on
 * the same profile type at the same speed, and two different profiles do not.
 */

import type {
  CDPEvent,
  CDPTarget,
  ConfiguredPlugin,
  PageContext,
  Profile,
  Send,
  SessionId,
} from './types.ts'
import { BROKERED } from './broker.ts'
import { order } from './plugin.ts'
import { Logger } from './logger.ts'
import { asError } from './utils.ts'
import type { Debug } from './debug.ts'

/** Compile URL globs into a predicate. Absent globs match every page. */
function compile(globs?: string[]): (url: string) => boolean {
  if (!globs || globs.length === 0) return () => true
  const patterns = globs.map((glob) =>
    new RegExp(
      '^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
        '$',
    )
  )
  return (url) => patterns.some((re) => re.test(url))
}

export interface ActorWire {
  send: Send
  profile: Profile
  signal: AbortSignal
}

/**
 * One actor instance bound to one page, and the handle it acts through.
 *
 * The handle is deliberately small (§6.2): it is not a second Playwright and
 * will not grow into one. What keeps that defensible is `send` and `cdp`, the
 * escape hatch — without a route back to CDP, the first actor that needed a
 * download intercepted would abandon the kind and write a `protocol` plugin,
 * giving up per-page lifetime and off-queue scheduling to get one command.
 */
class Handle implements PageContext {
  readonly target: CDPTarget
  readonly profile: Profile
  readonly signal: AbortSignal
  /** Which actor this handle belongs to; the runtime keys instances by it. */
  readonly name: string
  url = ''

  readonly #send: Send
  readonly #name: string
  readonly #log: Logger
  readonly #debug?: Debug
  /** Domains this actor turned on, so it may turn those and only those off. */
  readonly #enabled = new Set<string>()
  readonly #lifecycle = new Map<string, (() => unknown)[]>()
  readonly #watchers = new Map<string, Set<(params: unknown) => void>>()
  /** How many keystrokes and clicks have happened, so the jitter varies. */
  #beat = 0

  constructor(
    target: CDPTarget,
    name: string,
    wire: ActorWire,
    debug?: Debug,
  ) {
    this.target = target
    this.profile = wire.profile
    this.signal = wire.signal
    this.#send = wire.send
    this.name = name
    this.#name = name
    this.#log = Logger.get(`plugin:${name}`)
    this.#debug = debug
  }

  log(...args: unknown[]): void {
    this.#log.debug(
      args.map((a) => typeof a === 'string' ? a : Deno.inspect(a))
        .join(' '),
    )
  }

  /**
   * Deterministic jitter around a target delay, in milliseconds.
   *
   * Uniform random would be its own signal: real typing and real clicking have
   * a rhythm, and a cadence that is perfectly memoryless across sessions is a
   * machine. Seeding from the profile means the rhythm belongs to the identity.
   */
  #pause(base: number, spread: number): Promise<void> {
    const jitter = this.profile.noise(`${this.#name}:beat:${this.#beat++}`)
    return new Promise((resolve) => setTimeout(resolve, base + jitter * spread))
  }

  async eval<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<T> {
    const result = await this.#send('Runtime.evaluate', {
      expression: `(${fn.toString()})(${JSON.stringify(arg ?? null)})`,
      returnByValue: true,
      awaitPromise: true,
    }, this.target.sessionId) as {
      result?: { value?: T }
      exceptionDetails?: { exception?: { description?: string }; text: string }
    }
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      )
    }
    return result.result?.value as T
  }

  has(selector: string): Promise<boolean> {
    return this.eval(
      (sel: string) => document.querySelector(sel) !== null,
      selector,
    )
  }

  async wait(selector: string, timeout = 5_000): Promise<boolean> {
    // Polled rather than observed, because a `MutationObserver` needs a channel
    // back out of the page and the only reliable one is another evaluate
    // (`PluginContext.inject` explains why a binding is not it).
    const until = Date.now() + timeout
    while (Date.now() < until && !this.signal.aborted) {
      if (await this.has(selector).catch(() => false)) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  async click(selector: string): Promise<void> {
    const at = await this.eval((sel: string) => {
      const element = document.querySelector(sel)
      if (!element) return null
      element.scrollIntoView({ block: 'center' })
      const box = element.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }, selector)
    if (!at) throw new Error(`${this.#name}: no element matches ${selector}`)

    // The move matters as much as the click: a press with no preceding
    // `mousemove` is a shape no pointing device produces.
    const point = { ...at, button: 'left' as const, clickCount: 1 }
    await this.#send('Input.dispatchMouseEvent', {
      ...point,
      type: 'mouseMoved',
      clickCount: 0,
    }, this.target.sessionId)
    await this.#pause(30, 60)
    await this.#send('Input.dispatchMouseEvent', {
      ...point,
      type: 'mousePressed',
    }, this.target.sessionId)
    await this.#pause(40, 50)
    await this.#send('Input.dispatchMouseEvent', {
      ...point,
      type: 'mouseReleased',
    }, this.target.sessionId)
  }

  async fill(selector: string, text: string): Promise<void> {
    const found = await this.eval((sel: string) => {
      const element = document.querySelector(sel) as HTMLInputElement | null
      if (!element) return false
      element.focus()
      element.value = ''
      return true
    }, selector)
    if (!found) throw new Error(`${this.#name}: no element matches ${selector}`)

    // Per character through `Input`, not `Input.insertText`: insertText produces
    // no key events at all, so a field with a `keydown` listener never fires and
    // a page counting keystrokes sees a paste.
    for (const char of text) {
      await this.#send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char,
        unmodifiedText: char,
      }, this.target.sessionId)
      await this.#send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        text: char,
        unmodifiedText: char,
      }, this.target.sessionId)
      await this.#pause(40, 90)
    }
  }

  async goto(url: string): Promise<void> {
    await this.#send('Page.navigate', { url }, this.target.sessionId)
  }

  on(event: 'document' | 'close', fn: () => unknown): void {
    const held = this.#lifecycle.get(event) ?? []
    held.push(fn)
    this.#lifecycle.set(event, held)
  }

  /**
   * The escape hatch's outbound half (§6.4): any typed CDP command, bound to
   * this page's session.
   *
   * DANGER: the refusals below are not paternalism, they are the four ways one
   * actor silently breaks the rest of the session. Each throws at the call,
   * names the plugin and the command, and points at the supported route —
   * reaching this three times in one plugin means the work belongs in
   * `protocol` after all.
   */
  send = ((method: string, params?: unknown, _sessionId?: SessionId) => {
    if (method === 'Runtime.enable') {
      return Promise.reject(
        new Error(
          `${this.#name}: Runtime.enable is refused. It is the exact tell core ` +
            '`contexts` exists to suppress, and one actor calling it would ' +
            'undo every surface in this session',
        ),
      )
    }
    if (method in BROKERED) {
      return Promise.reject(
        new Error(`${this.#name}: ${method} is refused — ${BROKERED[method]}`),
      )
    }
    if (method.endsWith('.disable')) {
      const domain = method.slice(0, -'.disable'.length)
      if (!this.#enabled.has(domain)) {
        return Promise.reject(
          new Error(
            `${this.#name}: ${method} is refused because this actor did not ` +
              `enable ${domain}. Whatever is using it has no way to find out ` +
              'it stopped working',
          ),
        )
      }
    }
    if (method.endsWith('.enable')) {
      const domain = method.slice(0, -'.enable'.length)
      if (!this.#enabled.has(domain)) {
        this.#enabled.add(domain)
        // Logged once with the domain named: a newly enabled domain changes
        // what the session looks like from the browser's side, and nothing else
        // in the platform would report it.
        this.#debug?.conflict(
          `${this.#name} enabled ${domain} through the escape hatch`,
        )
      }
    }
    const sent = (this.#send as (
      m: string,
      p: unknown,
      s: SessionId,
    ) => Promise<unknown>)(method, params, this.target.sessionId)
    // DANGER: the branch is what makes `void page.send(…)` safe, and the RFC's
    // own escape-hatch example is written that way. Without a handler, a command
    // still in flight when the session tears down rejects into nothing and
    // becomes an unhandled rejection that takes the process down — a plugin
    // firing and forgetting on a page that closed is the ordinary case, not a
    // bug. `sent` itself is returned, so an author who does await still sees it.
    sent.catch((err) =>
      this.#log.debug(`${method} did not complete: ${asError(err).message}`)
    )
    return sent
  }) as PageContext['send']

  /**
   * The escape hatch's inbound half (§6.4): observe a typed CDP event on this
   * page's session. Returns an unsubscribe.
   *
   * DANGER: observe-only, and late. This is a copy of the event delivered after
   * the pipeline has already decided what happens to it, so an actor cannot
   * suppress, rewrite, or answer a CDP message — needing that is the signal that
   * you are writing the wrong kind. And it is scheduled off the message queue
   * like every other actor callback, so the page may have navigated by the time
   * yours runs: treat what you observed as a fact about the past and re-check
   * before acting on it.
   */
  cdp = ((method: string, fn: (params: unknown) => void) => {
    const held = this.#watchers.get(method) ?? new Set()
    held.add(fn)
    this.#watchers.set(method, held)
    return () => void held.delete(fn)
  }) as PageContext['cdp']

  /** Runtime-side: hand an event to whoever subscribed, never to the page path. */
  observe(evt: CDPEvent): void {
    const held = this.#watchers.get(evt.method)
    if (!held) return
    for (const fn of held) {
      try {
        fn(evt.params ?? {})
      } catch (err) {
        this.#log.error('a cdp() handler threw', { error: asError(err) })
      }
    }
  }

  /** Runtime-side: fire a lifecycle callback and swallow what it throws. */
  async fire(event: 'document' | 'close'): Promise<void> {
    for (const fn of this.#lifecycle.get(event) ?? []) {
      try {
        await fn()
      } catch (err) {
        if (this.signal.aborted) return
        this.#log.error(`an on('${event}') handler threw`, {
          error: asError(err),
        })
      }
    }
  }
}

/**
 * Every actor in a session, instantiated per page and scheduled off the message
 * queue.
 *
 * The queue separation is the whole point and it is one line: callbacks are
 * chained onto `#work` rather than awaited by the caller, so the transport is
 * never waiting on an actor and an actor is never waiting on the transport.
 */
export class Actors {
  readonly #plugins: ConfiguredPlugin[]
  readonly #wire: (target: CDPTarget) => ActorWire
  readonly #debug?: Debug
  /** One entry per page; a session-scoped actor keeps its first instance. */
  readonly #live = new Map<
    SessionId,
    { target: CDPTarget; handles: Handle[] }
  >()
  readonly #session = new Set<string>()
  /** The per-page task chain — deliberately not the transport's. */
  #work: Promise<unknown> = Promise.resolve()

  constructor(
    plugins: ConfiguredPlugin[],
    wire: (target: CDPTarget) => ActorWire,
    debug?: Debug,
  ) {
    this.#plugins = order(plugins)
    this.#wire = wire
    this.#debug = debug
    debug?.actors(
      this.#plugins.map((p) => ({ name: p.name, urls: p.urls })),
    )
  }

  get empty(): boolean {
    return this.#plugins.length === 0
  }

  /** Schedule work off the message queue, where an actor is allowed to be slow. */
  #schedule(run: () => Promise<void>): void {
    this.#work = this.#work.then(run).catch((err) =>
      Logger.get('actor').error('an actor task failed', { error: asError(err) })
    )
  }

  /**
   * A page attached. Instantiate whichever actors claim it, once its URL is
   * known — `urls` filters by URL and a target announces itself before it has
   * navigated, so instantiating on attach would match every actor against
   * `about:blank`.
   */
  attached(target: CDPTarget): void {
    if (target.type !== 'page' || this.#plugins.length === 0) return
    this.#live.set(target.sessionId, { target, handles: [] })
  }

  detached(sessionId: SessionId): void {
    const page = this.#live.get(sessionId)
    if (!page) return
    this.#live.delete(sessionId)
    for (const handle of page.handles) this.#session.delete(handle.name)
    // The closure *is* the page's state, so dropping the handle is the whole of
    // the cleanup — there is nothing keyed by session id to prune.
    this.#schedule(async () => {
      for (const handle of page.handles) await handle.fire('close')
    })
  }

  /**
   * A frame committed a document. Instantiates the actors that match the new
   * URL and have not been instantiated yet, then fires `on('document')`.
   */
  document(sessionId: SessionId, url: string, isMain: boolean): void {
    const page = this.#live.get(sessionId)
    if (!page || !isMain) return

    this.#schedule(async () => {
      for (const plugin of this.#plugins) {
        if (!compile(plugin.urls)(url)) continue
        // Per-page is the default because it is what nearly every actor wants;
        // `scope: 'session'` is for one coordinating across pages, like a login
        // that must happen once before the others proceed (§6.3).
        const scoped = plugin.scope === 'session'
        if (scoped && this.#session.has(plugin.name)) continue
        if (page.handles.some((h) => h.name === plugin.name)) continue

        const handle = new Handle(
          page.target,
          plugin.name,
          this.#wire(page.target),
          this.#debug,
        )
        handle.url = url
        try {
          await plugin.setup(handle)
        } catch (err) {
          // An actor that cannot set up does nothing, which is the same stand
          // down a surface takes (§2.9) — and far better than a half-armed one.
          const { message } = asError(err)
          Logger.get(`plugin:${plugin.name}`).error('setup failed', {
            error: asError(err),
          })
          this.#debug?.conflict(
            `${plugin.name} is not watching ${url}: ${message}`,
          )
          this.#debug?.actor(plugin.name, url, message)
          continue
        }
        this.#debug?.actor(plugin.name, url)
        page.handles.push(handle)
        if (scoped) this.#session.add(plugin.name)
      }

      for (const handle of page.handles) {
        handle.url = url
        await handle.fire('document')
      }
    })
  }

  /** Hand an observed event to every actor on the session it belongs to. */
  event(evt: CDPEvent): void {
    if (!evt.sessionId) return
    const page = this.#live.get(evt.sessionId)
    if (!page || page.handles.length === 0) return
    this.#schedule(() => {
      for (const handle of page.handles) handle.observe(evt)
      return Promise.resolve()
    })
  }

  /** Let a test or a teardown wait for what has been scheduled so far. */
  settled(): Promise<unknown> {
    return this.#work
  }
}
