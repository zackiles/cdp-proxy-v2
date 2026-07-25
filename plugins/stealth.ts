/**
 * @module plugins/stealth
 * @description The flagship stealth plugin (§8). Mirrors `rebrowser-patches` but at
 * the CDP network layer instead of patching Playwright's source.
 *
 * The tell: `Runtime.enable` makes Chrome report console activity and serialize
 * console arguments, the long-standing fingerprint for an attached DevTools
 * client. We defeat it by never forwarding the client's `Runtime.enable`; instead
 * we hand Playwright the execution-context ids it would have learned from it.
 *
 * NOTE: on Chrome 147 the classic page-side probes for this (a getter on an
 * error's `stack`, proxy traps) no longer fire — console previews skip accessors.
 * The guarantee here is the wire-level one: the command never reaches the browser.
 * See `docs/stealth.md` for the measurements behind every choice below.
 *
 * Because the runtime stays disabled, Chrome never announces contexts, so we
 * synthesize `Runtime.executionContextCreated` for both worlds Playwright needs:
 *
 * - main world: derived via a throwaway `Runtime.addBinding` + an on-new-document
 *   listener that the isolated world pokes with a `CustomEvent`; the resulting
 *   `Runtime.bindingCalled` carries the real main-world context id (validated: no
 *   `Runtime.enable` required).
 * - utility world: `Page.createIsolatedWorld` with Playwright's utility world name
 *   returns the id of the world Playwright auto-creates via its own
 *   `addScriptToEvaluateOnNewDocument({ worldName })`.
 *
 * Contexts are re-provided on every top-frame navigation and de-duplicated per
 * session, since a duplicate `executionContextCreated` makes Playwright treat the
 * context as destroyed.
 */

import { definePlugin } from '../src/plugin.ts'
import type { PluginContext, PluginFactory, SessionId } from '../src/types.ts'
import type { Protocol } from 'devtools-protocol/types/protocol.d.ts'

/** The world name Playwright uses for its internal (utility) execution context. */
const UTILITY_WORLD = '__playwright_utility_world__'

/**
 * The marker `Frame.setContent` logs via `console.debug` after `document.open()`
 * so it can clear the frame's lifecycle and wait for the new document to load.
 */
const SET_CONTENT_TAG = /--playwright--set--content--[^"]+?--\d+--/

/**
 * The execution context a `Runtime.*` call targets, either given outright or
 * encoded as the middle field of a remote object id (`<isolate>.<context>.<n>`).
 */
/** Playwright keys contexts by this, so announce and retract must agree on it. */
function uniqueId(id: number, frameId: string): string {
  return `${id}.${frameId}`
}

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

export interface StealthOptions {
  /** Override the spoofed User-Agent; defaults to the browser's own, de-headlessed. */
  userAgent?: string
  [key: string]: unknown
}

export const stealth: PluginFactory<StealthOptions> = definePlugin<
  StealthOptions
>({
  name: 'stealth',
  priority: 100,
  setup(cfg, ctx) {
    const setUp = new Set<SessionId>()
    /**
     * What we have provided, per session and then per frame: the document
     * (`loaderId`) the contexts belong to, and their ids so they can be retracted
     * when that document goes away. Keyed by frame because every frame in a page
     * needs its own pair of worlds, and subframes navigate independently.
     */
    const frames = new Map<
      SessionId,
      Map<string, { loaderId: string; contexts: Set<number> }>
    >()
    // Active main-world binding handlers, keyed by the throwaway binding name.
    const bindings = new Map<
      string,
      (frameId: string, contextId: number) => void
    >()
    // Playwright's own createIsolatedWorld calls (client id → world info); their
    // executionContextCreated is suppressed too, so we synthesize it on response.
    const pendingIso = new Map<
      number,
      { sessionId?: SessionId; frameId: string; worldName: string }
    >()
    let cleanUa:
      | { userAgent: string; metadata: Protocol.Emulation.UserAgentMetadata }
      | undefined

    // DANGER: the metadata must agree with the UA string. Claiming macOS while the
    // UA says Linux is a far louder tell than the headless marker we're hiding.
    function brandsFor(
      source: string,
      userAgent: string,
    ): Protocol.Emulation.UserAgentMetadata {
      const major = source.match(/Chrome\/(\d+)/)?.[1] ??
        userAgent.match(/Chrome\/(\d+)/)?.[1] ?? '147'
      const architecture = Deno.build.arch === 'aarch64' ? 'arm' : 'x86'
      const platform = /Windows/i.test(userAgent)
        ? { platform: 'Windows', platformVersion: '15.0.0' }
        : /Linux|X11|Android/i.test(userAgent)
        ? { platform: 'Linux', platformVersion: '' }
        : { platform: 'macOS', platformVersion: '15.0.0' }

      return {
        brands: [
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
          { brand: 'Not?A_Brand', version: '99' },
        ],
        fullVersion: `${major}.0.0.0`,
        ...platform,
        architecture,
        model: '',
        mobile: false,
      }
    }

    async function resolveUa(): Promise<typeof cleanUa> {
      if (cleanUa) return cleanUa
      if (cfg.userAgent) {
        return (cleanUa = {
          userAgent: cfg.userAgent,
          metadata: brandsFor(cfg.userAgent, cfg.userAgent),
        })
      }
      const v = await ctx.send('Browser.getVersion')
      const userAgent = v.userAgent.replace('HeadlessChrome', 'Chrome')
      return (cleanUa = {
        userAgent,
        metadata: brandsFor(v.product, userAgent),
      })
    }

    function frameState(
      sessionId: SessionId,
      frameId: string,
    ): { loaderId: string; contexts: Set<number> } {
      let byFrame = frames.get(sessionId)
      if (!byFrame) frames.set(sessionId, byFrame = new Map())
      let state = byFrame.get(frameId)
      if (!state) {
        byFrame.set(frameId, state = { loaderId: '', contexts: new Set() })
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

    // Derive the real main-world context id without enabling the runtime: a fresh
    // binding + an on-new-document listener injected into the *current* document
    // (runImmediately) that the isolated world triggers via a CustomEvent. Fresh
    // per call so it survives navigations (bindings/listeners don't carry over).
    async function mainWorld(
      sessionId: SessionId,
      frameId: string,
    ): Promise<number | undefined> {
      const name = `__pw_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
      let resolved = 0
      const got = new Promise<number>((resolve) => {
        bindings.set(name, (payload, id) => {
          if (resolved > 0 || payload !== frameId) return
          resolved = id
          resolve(id)
        })
      })
      let timer = 0
      const timeout = new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), 4000)
      })

      await ctx.send('Runtime.addBinding', { name }, sessionId)
      const script = await ctx.send(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source:
            `document.addEventListener('${name}',(e)=>self['${name}'](e.detail.frameId))`,
          runImmediately: true,
        },
        sessionId,
      )
      const iso = await ctx.send(
        'Page.createIsolatedWorld',
        { frameId, worldName: name, grantUniveralAccess: true },
        sessionId,
      )
      await ctx.send(
        'Runtime.evaluate',
        {
          expression:
            `document.dispatchEvent(new CustomEvent('${name}',{detail:{frameId:'${frameId}'}}))`,
          contextId: iso.executionContextId,
        },
        sessionId,
      )

      const id = await Promise.race([got, timeout])
      clearTimeout(timer)
      bindings.delete(name)
      // Leaving the binding on `window` and the listener on every future document
      // would itself be a tell, so drop both now that we have the id.
      await Promise.all([
        ctx.send('Runtime.removeBinding', { name }, sessionId).catch(() => {}),
        ctx.send(
          'Page.removeScriptToEvaluateOnNewDocument',
          { identifier: script.identifier },
          sessionId,
        ).catch(() => {}),
      ])
      return id
    }

    async function provide(
      sessionId: SessionId,
      frameId: string,
      loaderId: string,
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

      const mainId = await mainWorld(sessionId, frameId)
      if (mainId != null) announce(sessionId, frameId, mainId, '', true)
      const util = await ctx.send(
        'Page.createIsolatedWorld',
        { frameId, worldName: UTILITY_WORLD, grantUniveralAccess: true },
        sessionId,
      )
      announce(
        sessionId,
        frameId,
        util.executionContextId,
        UTILITY_WORLD,
        false,
      )
    }

    async function setupSession(sessionId: SessionId): Promise<void> {
      if (setUp.has(sessionId)) return
      setUp.add(sessionId)
      await ctx.send('Page.enable', undefined, sessionId)

      const ua = await resolveUa()
      if (ua) {
        await ctx
          .send(
            'Emulation.setUserAgentOverride',
            { userAgent: ua.userAgent, userAgentMetadata: ua.metadata },
            sessionId,
          )
          .catch(() => {})
      }

      // A page can already have subframes by the time the client enables the
      // runtime, and each one needs its own worlds. Awaited in tree order so
      // parents are announced before children (v1 raced here).
      const walk = async (node: Protocol.Page.FrameTree): Promise<void> => {
        await provide(sessionId, node.frame.id, node.frame.loaderId)
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

      onEvent(evt) {
        if (evt.method === 'Runtime.bindingCalled') {
          const handler = bindings.get(evt.params?.name as string)
          if (handler) {
            handler(
              evt.params!.payload as string,
              evt.params!.executionContextId as number,
            )
            return null // internal handshake, never leak to the client
          }
        }
        return evt
      },

      // Every frame that commits a document needs its own pair of worlds, not
      // just the top one — subframes are where v1's context handling died.
      onDocument({ sessionId, frameId, loaderId, isMain }) {
        if (!setUp.has(sessionId)) return
        if (isMain) {
          // A top-frame commit tears down every context in the page, so forget
          // the whole tree rather than retracting frame by frame.
          frames.delete(sessionId)
          ctx.emit('Runtime.executionContextsCleared', {}, sessionId)
        }
        provide(sessionId, frameId, loaderId).catch(() => {})
      },

      // A long-lived connection can open and close many pages, so per-target
      // bookkeeping is dropped with the target rather than at the end.
      onTargetDetached(target) {
        setUp.delete(target.sessionId)
        frames.delete(target.sessionId)
      },

      onSessionEnd(_ctx: PluginContext) {
        setUp.clear()
        frames.clear()
        bindings.clear()
        pendingIso.clear()
      },
    }
  },
})

export default stealth
