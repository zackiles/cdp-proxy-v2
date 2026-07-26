/**
 * @module realms
 * @description Get a session's surface bundle into every JavaScript context the
 * page can reach (§7.1).
 *
 * This is the problem corsac could not solve, and it is not a subtlety: a
 * `WebGLRenderingContext.prototype` patch installed on `window` is bypassed by
 * `OffscreenCanvas` in a worker, and a `navigator.hardwareConcurrency` patch is
 * bypassed by asking a same-origin iframe. A surface that only reaches the main
 * frame is not a surface, it is a suggestion — and the detection is one line of
 * JavaScript in either case.
 *
 * Two mechanisms, because Chrome gives workers no third option:
 *
 * | Realm                  | How                                                          |
 * | ---------------------- | ------------------------------------------------------------ |
 * | `page`, `iframe`       | `Page.addScriptToEvaluateOnNewDocument`, which already covers the whole frame tree. |
 * | `worker`, `service_worker` | `Runtime.evaluate` while the target is paused at start.  |
 *
 * ## Why the worker path looks like that
 *
 * A worker has no `Page` domain, so there is no "run this before anything else"
 * to register. The only moment before the worker's own code runs is the pause
 * that `Target.setAutoAttach({ waitForDebuggerOnStart: true })` creates, and the
 * only way to run code during it is `Runtime.evaluate`.
 *
 * The pause belongs to whoever attached, and that is the client: Playwright sets
 * auto-attach with `waitForDebuggerOnStart` on every page session it opens, so
 * the worker is already paused and already being reported to us by the time we
 * see `Target.attachedToTarget`. The proxy wins that race structurally rather
 * than by timing — the event reaches the client only after the pipeline has
 * finished with it, so the bundle is in before the client knows the worker
 * exists.
 *
 * DANGER: do not resume the worker here. `Runtime.runIfWaitingForDebugger` is
 * the client's to send, and sending it first releases the worker before
 * Playwright has attached its own listeners — which loses events the caller was
 * promised rather than gaining anything, since the evaluate has already run.
 *
 * DANGER: `Runtime.enable` is not sent on a worker session, and this is the same
 * rule from the other side. Core `contexts` (§8.3) suppresses `Runtime.enable`
 * for documents and deliberately lets it through on workers, because suppressing
 * it there strands Playwright without contexts. `Runtime.evaluate` needs no
 * enable, so the worker path stays clear of the argument entirely.
 */

import type { CDPTarget, Realm, SessionId } from './types.ts'
import type { Compiled } from './surface.ts'
import { asError } from './utils.ts'
import type { Send } from './types.ts'

/** What delivery needs from the connection to reach one target. */
export interface Wire {
  /** `Page.addScriptToEvaluateOnNewDocument` in the main world of a document. */
  inject(source: string, sessionId: SessionId): Promise<unknown>
  send: Send
  /**
   * Write a command at a paused target and drop the reply.
   *
   * DANGER: this exists because awaiting the reply deadlocks, and the deadlock
   * is not obvious. `Runtime.evaluate` on a worker paused by
   * `waitForDebuggerOnStart` runs the code but does not answer until the worker
   * resumes; the worker resumes when the client sends
   * `Runtime.runIfWaitingForDebugger`; and the client cannot send it because
   * `Target.attachedToTarget` reaches it only after delivery finishes. Awaiting
   * therefore hangs until `ctx.send`'s timeout, and the late reply then arrives
   * with an id no client callback is waiting on, which Playwright treats as a
   * protocol violation and asserts on. Ordering is still guaranteed: CDP
   * processes one session's messages in the order they were written, and this
   * one is written before the attach event is forwarded.
   *
   * The reply is read for a thrown exception on its way to the bin, so a bundle
   * that fails in a worker says so — it just says so late, whenever the worker
   * is resumed, rather than at the point of delivery.
   */
  evaluate(source: string, sessionId: SessionId): void
  log(text: string): void
}

/**
 * Which realm a CDP target is, or `undefined` for the ones no bundle belongs in.
 *
 * `other`, `browser`, and `background_page` are deliberately not realms: they
 * are not contexts a page can reach, so patching them changes nothing a detector
 * can see while adding somewhere for a patch to go wrong.
 */
export function realmOf(target: CDPTarget): Realm | undefined {
  switch (target.type) {
    case 'page':
      return 'page'
    case 'iframe':
      return 'iframe'
    case 'worker':
    case 'shared_worker':
      return 'worker'
    case 'service_worker':
      return 'service_worker'
    default:
      return undefined
  }
}

/**
 * Install a session's surfaces on one target: the bundle first, then the
 * `Emulation.*` overrides, then the merged headers.
 *
 * DANGER: the bundle goes into the **main world**, which `ctx.inject` otherwise
 * discourages. It has to: `WebGLRenderingContext.prototype` in an isolated world
 * is not the page's prototype, so a patch there changes nothing the page can see
 * (§4.5). That exposure is the reason `emulate` is preferred wherever Chrome can
 * make the same change below the JavaScript layer.
 */
export async function deliver(
  compiled: Compiled,
  target: CDPTarget,
  wire: Wire,
): Promise<void> {
  const realm = realmOf(target)
  if (!realm) return

  const source = compiled.bundle(realm)
  if (source) {
    if (realm === 'worker' || realm === 'service_worker') {
      wire.evaluate(source, target.sessionId)
    } else {
      try {
        await wire.inject(source, target.sessionId)
      } catch (err) {
        // A frame that went away between attach and inject is ordinary, and a
        // surface failing one realm must not stop it reaching the others.
        wire.log(`${realm} bundle not delivered: ${asError(err).message}`)
      }
    }
  }

  for (const { name, hooks } of compiled.emulate) {
    try {
      await hooks.emulate!({
        realm,
        sessionId: target.sessionId,
        send: wire.send,
      })
    } catch (err) {
      // One override failing leaves the rest installed. The alternative — giving
      // up on the target — would leave a page carrying half a claim, which is the
      // incoherence the whole kind exists to avoid.
      wire.log(`${name} could not emulate: ${asError(err).message}`)
    }
  }

  // Headers are not delivered here. They belong to the broker, which merges
  // every surface's contribution with the client's own before making the single
  // `Network.setExtraHTTPHeaders` call the domain has room for (§7.2).
}
