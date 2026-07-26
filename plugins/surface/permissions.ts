/**
 * @module plugins/surface/permissions
 * @description Making `navigator.permissions.query` agree with the API it is
 * answering about.
 *
 * At the kind root, and legally so (§10.2): it reads no profile field because it
 * makes no claim about a machine. It repairs a contradiction — the oldest
 * headless tell there is, and still the first one every detector checks:
 *
 * ```js
 * Notification.permission                              // 'denied'
 * await navigator.permissions.query({name:'notifications'})  // 'prompt'
 * ```
 *
 * No real browser says both. Headless Chrome does, because it denies
 * notifications outright while the Permissions API keeps reporting the default
 * it would have prompted for. One `await` finds it.
 *
 * The repair is deliberately one-directional: whatever `Notification.permission`
 * says is taken as the truth and the query is made to match. The alternative —
 * making the query the truth — would mean a page that goes on to call
 * `Notification.requestPermission()` gets an answer contradicting the one it was
 * just given, which is the same bug facing the other way.
 */

import { definePlugin } from '../../src/plugin.ts'
import type { PluginFactory } from '../../src/types.ts'

export interface PermissionsOptions {
  [key: string]: unknown
}

export const permissions: PluginFactory<PermissionsOptions> = definePlugin<
  PermissionsOptions
>({
  kind: 'surface',
  name: 'permissions',
  setup() {
    return {
      // `navigator.permissions` exists in a worker, but `Notification` does not,
      // so there is nothing there to disagree with.
      realms: ['page', 'iframe'],
      page() {
        const api = globalThis.navigator?.permissions
        if (!api || !globalThis.Notification) return

        const query = api.query
        api.query = native(async function (
          this: Permissions,
          descriptor: PermissionDescriptor,
        ) {
          const status = await query.call(this, descriptor)
          if (descriptor?.name !== 'notifications') return status

          const permission = globalThis.Notification.permission
          const agrees = permission === 'default'
            ? 'prompt'
            : permission as PermissionState
          if (status.state === agrees) return status

          // An own property rather than a replacement object: `status` keeps its
          // identity, its `onchange`, and its place in the event graph, and only
          // the one value that was wrong is shadowed.
          Object.defineProperty(status, 'state', {
            get: native(() => agrees, 'get state'),
            enumerable: true,
            configurable: true,
          })
          return status
        }, 'query') as typeof query
      },
    }
  },
})

export default permissions
