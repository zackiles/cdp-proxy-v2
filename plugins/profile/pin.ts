/**
 * @module plugins/profile/pin
 * @description One fixed identity, by id (§2.3). For debugging, for tests, and
 * for re-opening yesterday's failure on the machine it failed on.
 *
 * ```ts
 * chromium.launch({ plugins: [pin({ id: Deno.env.get('CDP_PROFILE') }), stealth()] })
 * ```
 *
 * It answers only when an id is set, so the line above is safe to leave in place:
 * with the variable unset the loader stands aside and the chain falls through to
 * whatever is next, ending at core `generate`.
 *
 * The id is not a key into a store. It is the seed: the same id reproduces the
 * same machine from the same tables, which is what makes a pinned run repeatable
 * across processes and across days without a file to keep in sync. It still
 * honours the constraint — asking for an id and an OS the id does not draw gets
 * you the next loader rather than an incoherent hybrid.
 */

import { definePlugin } from '../../src/plugin.ts'
import { random } from '../../src/profile.ts'
import { machine } from '../../src/core/generate.ts'
import type { PluginFactory } from '../../src/types.ts'

export interface PinOptions {
  /** The identity to reproduce. Unset means this loader stands aside. */
  id?: string
  [key: string]: unknown
}

export const pin: PluginFactory<PinOptions> = definePlugin<PinOptions>({
  kind: 'profile',
  name: 'pin',
  // Above every other loader: a pinned run is an instruction, not a preference.
  priority: 100,
  setup: (options) => ({
    draw(constraint) {
      const id = options.id ?? constraint.id
      if (!id) return undefined
      return machine({ ...constraint, id }, random(id), id)
    },
  }),
})

export default pin
