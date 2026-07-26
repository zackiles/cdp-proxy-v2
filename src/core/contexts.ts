/**
 * @module core/contexts
 * @description Core (§8.3): the client is not announced on the wire.
 *
 * The tell: `Runtime.enable` makes Chrome report console activity and serialize
 * console arguments, the long-standing fingerprint for an attached DevTools
 * client. We defeat it by never forwarding the client's `Runtime.enable`; instead
 * we hand Playwright the execution-context ids it would have learned from it.
 *
 * This is the precondition the rest of the platform rests on, not more stealth
 * layered on top of it: a session presenting a beautifully coherent fingerprint
 * while forwarding `Runtime.enable` has already announced itself, and every
 * surface's work is spent. It is therefore always installed and pinned first,
 * and it takes no author-facing options.
 *
 * NOTE: on Chrome 147 the classic page-side probes for this (a getter on an
 * error's `stack`, proxy traps) no longer fire — console previews skip accessors.
 * The guarantee here is the wire-level one: the command never reaches the browser.
 * See `docs/stealth.md` for the measurements behind every choice below.
 *
 * Because the runtime stays disabled, Chrome never announces contexts, so we
 * synthesize `Runtime.executionContextCreated` for both worlds Playwright needs:
 *
 * - main world: read off a remote object handle, whose id encodes the context that
 *   owns it. Nothing is injected and nothing is left behind — see {@link mainWorld}.
 * - utility world: `Page.createIsolatedWorld` with Playwright's utility world name
 *   returns the id of the world Playwright auto-creates via its own
 *   `addScriptToEvaluateOnNewDocument({ worldName })`.
 *
 * Contexts are re-provided on every top-frame navigation and de-duplicated per
 * session, since a duplicate `executionContextCreated` makes Playwright treat the
 * context as destroyed.
 */

import { definePlugin } from '../plugin.ts'
import type { PluginFactory, SessionId } from '../types.ts'
import type { Protocol } from 'devtools-protocol/types/protocol.d.ts'

/** The world name Playwright uses for its internal (utility) execution context. */
const UTILITY_WORLD = '__playwright_utility_world__'

/**
 * The marker `Frame.setContent` logs via `console.debug` after `document.open()`
 * so it can clear the frame's lifecycle and wait for the new document to load.
 */
const SET_CONTENT_TAG = /--playwright--set--content--[^"]+?--\d+--/

/** Playwright keys contexts by this, so announce and retract must agree on it. */
function uniqueId(id: number, frameId: string): string {
  return `${id}.${frameId}`
}

/**
 * The execution context a `Runtime.*` call targets, either given outright or
 * encoded as the middle field of a remote object id (`<isolate>.<context>.<n>`).
 */
function contextOf(
  params: Record<string, unknown> | undefined,
): number | undefined {
  if (!params) return undefined
  if (typeof params.contextId === 'number') return params.contextId
  if (typeof params.objectId === 'string') {
    const id = Number(params.objectId.split('.')[1])
    if (Number.isFinite(id)) return id
  }
  return undefined
}

export const contexts: PluginFactory<Record<string, unknown>> = definePlugin({
  kind: 'protocol',
  name: 'contexts',
  setup(_cfg, ctx) {
    /**
     * What we have provided for one target: whether it has been set up at all,
     * and per frame the document (`loaderId`) its contexts belong to plus their
     * ids, so they can be retracted when that document goes away. Keyed by frame
     * because every frame needs its own pair of worlds and subframes navigate
     * independently. Held in `ctx.state` so a closed page takes it with it.
     */
    const target = (sessionId: SessionId) =>
      ctx.state(sessionId, () => ({
        ready: false,
        frames: new Map<string, { loaderId: string; contexts: Set<number> }>(),
      }))
    // Playwright's own createIsolatedWorld calls (client id → world info); their
    // executionContextCreated is suppressed too, so we synthesize it on response.
    const pendingIso = new Map<
      number,
      { sessionId?: SessionId; frameId: string; worldName: string }
    >()

    function frameState(
      sessionId: SessionId,
      frameId: string,
    ): { loaderId: string; contexts: Set<number> } {
      const { frames } = target(sessionId)
      let state = frames.get(frameId)
      if (!state) {
        frames.set(frameId, state = { loaderId: '', contexts: new Set() })
      }
      return state
    }

    function announce(
      sessionId: SessionId,
      frameId: string,
      id: number,
      name: string,
      isDefault: boolean,
    ): void {
      const { contexts } = frameState(sessionId, frameId)
      if (contexts.has(id)) return
      contexts.add(id)
      ctx.emit(
        'Runtime.executionContextCreated',
        {
          context: {
            id,
            origin: '',
            name,
            uniqueId: uniqueId(id, frameId),
            auxData: {
              isDefault,
              type: isDefault ? 'default' : 'isolated',
              frameId,
            },
          },
        },
        sessionId,
      )
    }

    /**
     * The frame's main-world context id, without enabling the runtime and without
     * touching the page.
     *
     * A remote object's id encodes the context that owns it, so any handle into a
     * frame names that frame's world. The main frame answers `Runtime.evaluate`
     * directly; a subframe needs `DOM.resolveNode`, which with no
     * `executionContextId` resolves in the node's *own* frame default world — the
     * only way to name a subframe's world from outside. Verified against what
     * `Runtime.enable` announces, for same-origin and cross-origin subframes alike.
     *
     * DANGER: do not go back to deriving this with `Runtime.addBinding`.
     * `Runtime.removeBinding` only stops *future* contexts receiving the binding;
     * the function it already installed stays on `window` for the life of the
     * document. That left a uniquely-named global on every page — a far louder tell
     * than the `Runtime.enable` this plugin exists to hide.
     */
    async function mainWorld(
      sessionId: SessionId,
      frameId: string,
      isMain: boolean,
    ): Promise<number | undefined> {
      let objectId: string | undefined
      if (isMain) {
        objectId = (await ctx.send(
          'Runtime.evaluate',
          { expression: 'self' },
          sessionId,
        ))
          .result.objectId
      } else {
        const owner = await ctx.send(
          'DOM.getFrameOwner',
          { frameId },
          sessionId,
        )
        const described = await ctx.send(
          'DOM.describeNode',
          { backendNodeId: owner.backendNodeId, pierce: true },
          sessionId,
        )
        const document = described.node.contentDocument?.backendNodeId
        if (document === undefined) return undefined
        objectId = (await ctx.send(
          'DOM.resolveNode',
          { backendNodeId: document },
          sessionId,
        )).object.objectId
      }
      if (objectId === undefined) return undefined
      // Invisible to the page, but holding it would pin the frame's objects for as
      // long as the session lives.
      await ctx.send('Runtime.releaseObject', { objectId }, sessionId)
        .catch(() => {})
      return contextOf({ objectId })
    }

    async function provide(
      sessionId: SessionId,
      frameId: string,
      loaderId: string,
      isMain: boolean,
    ): Promise<void> {
      const state = frameState(sessionId, frameId)
      if (state.loaderId === loaderId) return
      // Whatever we announced belonged to the outgoing document and is gone; a
      // client left holding those ids would wait forever on them.
      for (const id of state.contexts) {
        ctx.emit(
          'Runtime.executionContextDestroyed',
          {
            executionContextId: id,
            executionContextUniqueId: uniqueId(id, frameId),
          },
          sessionId,
        )
      }
      state.contexts.clear()
      state.loaderId = loaderId

      // The frame-tree walk and `onDocument` both provision, so two documents can
      // be in flight for one frame. Whoever is no longer the current document must
      // stay silent: announcing a second id for the same frame is what makes
      // Playwright decide the live context was destroyed.
      const current = () =>
        state.loaderId === loaderId &&
        target(sessionId).frames.get(frameId) === state

      const mainId = await mainWorld(sessionId, frameId, isMain)
      if (!current()) return
      if (mainId != null) announce(sessionId, frameId, mainId, '', true)

      const util = await ctx.send(
        'Page.createIsolatedWorld',
        { frameId, worldName: UTILITY_WORLD, grantUniveralAccess: true },
        sessionId,
      )
      if (!current()) return
      announce(
        sessionId,
        frameId,
        util.executionContextId,
        UTILITY_WORLD,
        false,
      )
    }

    async function setupSession(sessionId: SessionId): Promise<void> {
      const state = target(sessionId)
      if (state.ready) return
      state.ready = true
      await ctx.send('Page.enable', undefined, sessionId)

      // A page can already have subframes by the time the client enables the
      // runtime, and each one needs its own worlds. Awaited in tree order so
      // parents are announced before children (v1 raced here).
      const walk = async (node: Protocol.Page.FrameTree): Promise<void> => {
        await provide(
          sessionId,
          node.frame.id,
          node.frame.loaderId,
          !node.frame.parentId,
        )
        for (const child of node.childFrames ?? []) await walk(child)
      }
      await walk(
        (await ctx.send('Page.getFrameTree', undefined, sessionId)).frameTree,
      )
    }

    return {
      onRequest(msg) {
        if (msg.method === 'Runtime.enable') {
          if (!msg.sessionId) return msg // browser-level: harmless, let it through
          // Only documents carry the console tell and can be given synthetic
          // contexts. Workers have no Page domain, so suppressing it there would
          // strand Playwright without contexts and hang every worker evaluate.
          const type = ctx.targets.get(msg.sessionId)?.type
          if (type !== 'page' && type !== 'iframe') return msg
          setupSession(msg.sessionId).catch((e) => {
            if (!ctx.signal.aborted) ctx.log('setup failed', e)
          })
          return { respond: {} } // mock success, NEVER forward (defeats the tell)
        }
        if (msg.method === 'Page.createIsolatedWorld') {
          const p = (msg.params ?? {}) as { frameId: string; worldName: string }
          pendingIso.set(msg.id, {
            sessionId: msg.sessionId,
            frameId: p.frameId,
            worldName: p.worldName,
          })
        }
        // `setContent` waits for its own console.debug(tag) to come back before it
        // clears the frame lifecycle. That echo rides on Runtime.consoleAPICalled,
        // which the suppressed runtime never sends, so it would hang until timeout.
        // Replay it here, ahead of the document's load events.
        if (
          msg.sessionId &&
          (msg.method === 'Runtime.callFunctionOn' ||
            msg.method === 'Runtime.evaluate')
        ) {
          const tag = JSON.stringify(msg.params ?? {}).match(SET_CONTENT_TAG)
            ?.[0]
          const contextId = tag ? contextOf(msg.params) : undefined
          if (tag && contextId != null) {
            ctx.emit(
              'Runtime.consoleAPICalled',
              {
                type: 'debug',
                args: [{ type: 'string', value: tag }],
                executionContextId: contextId,
                timestamp: Date.now(),
              },
              msg.sessionId,
            )
          }
        }
        return msg
      },

      onResponse(msg) {
        const iso = pendingIso.get(msg.id)
        if (iso) {
          pendingIso.delete(msg.id)
          const id = msg.result?.executionContextId as number | undefined
          if (id != null && iso.sessionId) {
            announce(iso.sessionId, iso.frameId, id, iso.worldName, false)
          }
        }
        return msg
      },

      // Every frame that commits a document needs its own pair of worlds, not
      // just the top one — subframes are where v1's context handling died.
      onDocument({ sessionId, frameId, loaderId, isMain }) {
        const state = target(sessionId)
        if (!state.ready) return
        if (isMain) {
          // A top-frame commit tears down every context in the page, so forget
          // the whole tree rather than retracting frame by frame.
          state.frames.clear()
          ctx.emit('Runtime.executionContextsCleared', {}, sessionId)
        }
        provide(sessionId, frameId, loaderId, isMain).catch(() => {})
      },

      onSessionEnd() {
        pendingIso.clear()
      },
    }
  },
})
