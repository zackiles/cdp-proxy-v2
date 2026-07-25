/**
 * @module plugins/recorder
 * @description Records a session's CDP traffic and serves it back over the custom
 * RPC namespace. Doubles as the worked example for plugin authors: it touches
 * every message hook, keeps per-session state in the factory closure, and answers
 * a `Proxy.*` method with `{ respond }` so the browser never sees the call.
 *
 * ```ts
 * const browser = await chromium.launch({ plugins: [stealth(), recorder()] })
 * const cdp = await browser.newBrowserCDPSession()
 * const { entries } = await cdp.send('Proxy.history')
 * ```
 */

import { definePlugin } from '../src/plugin.ts'
import type { PluginFactory } from '../src/types.ts'

export interface RecorderOptions {
  /** Newest-N entries to keep; older ones are dropped. */
  limit?: number
  /** Record events too, not just commands and their responses. */
  events?: boolean
  [key: string]: unknown
}

export interface Entry {
  direction: 'request' | 'response' | 'event'
  method: string
  at: number
  sessionId?: string
}

export const recorder: PluginFactory<RecorderOptions> = definePlugin<
  RecorderOptions
>({
  name: 'recorder',
  defaults: { limit: 5_000, events: false },
  setup(cfg) {
    const entries: Entry[] = []
    // Responses carry no method, so remember what each command id asked for.
    const methods = new Map<number, string>()

    const record = (entry: Entry) => {
      entries.push(entry)
      if (entries.length > cfg.limit!) entries.shift()
    }

    return {
      onRequest(msg) {
        if (msg.method === 'Proxy.history') {
          return { respond: { entries: [...entries] } }
        }
        methods.set(msg.id, msg.method)
        record({
          direction: 'request',
          method: msg.method,
          at: Date.now(),
          sessionId: msg.sessionId,
        })
        return msg
      },

      onResponse(msg) {
        const method = methods.get(msg.id)
        if (method) {
          methods.delete(msg.id)
          record({
            direction: 'response',
            method,
            at: Date.now(),
            sessionId: msg.sessionId,
          })
        }
        return msg
      },

      onEvent(evt) {
        if (cfg.events) {
          record({
            direction: 'event',
            method: evt.method,
            at: Date.now(),
            sessionId: evt.sessionId,
          })
        }
        return evt
      },

      onSessionEnd(ctx) {
        ctx.log(`recorded ${entries.length} messages`)
        entries.length = 0
        methods.clear()
      },
    }
  },
})

export default recorder
