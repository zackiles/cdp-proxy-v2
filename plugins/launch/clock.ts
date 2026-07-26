/**
 * @module plugins/launch/clock
 * @description Make the process's own timezone the one the profile claims (§9.1).
 *
 * Chrome reads `TZ` from its environment on Linux and macOS, so the browser
 * genuinely *is* in `America/New_York` rather than being told to say so. That
 * matters because `Emulation.setTimezoneOverride` reaches `Intl` and `Date` and
 * nothing else: a page that compares `new Date().getTimezoneOffset()` against a
 * timestamp minted by a worker, or against the `Date` header of a request the
 * browser made, catches an override and cannot catch this.
 *
 * The two are complementary rather than redundant. `surface/timezone.ts` is
 * still needed, because a pooled process was started before this session's
 * profile existed and the flag cannot be changed afterwards. Coverage reports
 * `timezone` as read by both, which is how deleting one of them later shows up
 * in CI rather than as a detection three months on.
 *
 * IMPORTANT: this costs a browser process per session (§3.3). It is worth it
 * when the timezone is load-bearing — a geo-consistent persona behind a
 * residential proxy — and not worth it for a session that only needs the page
 * to agree with itself.
 */

import { definePlugin } from '../../src/plugin.ts'
import type { PluginFactory } from '../../src/types.ts'

export interface ClockOptions {
  [key: string]: unknown
}

export const clock: PluginFactory<ClockOptions> = definePlugin<ClockOptions>({
  kind: 'launch',
  name: 'clock',
  setup: (_options, ctx) => ({ env: { TZ: ctx.profile.timezone } }),
})

export default clock
