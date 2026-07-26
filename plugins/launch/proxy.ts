/**
 * @module plugins/launch/proxy
 * @description Route the browser's traffic through an upstream proxy (§3).
 *
 * DANGER: credentials never go on the command line. `--proxy-server` accepts a
 * `user:pass@host` form and Chrome will take it, but the command line of a
 * running process is world-readable on every platform this runs on, and it is
 * the one place a fingerprint of the operator rather than the machine can leak.
 * The pair is handed to the Fetch broker instead, which answers
 * `Fetch.authRequired` (§7.2).
 */

import { definePlugin } from '../../src/plugin.ts'
import type { PluginFactory } from '../../src/types.ts'

export interface ProxyOptions {
  /** `http://user:pass@host:port`, or any scheme Chrome accepts. */
  url: string
  /** Hosts to reach directly, as Chrome's `--proxy-bypass-list` spells them. */
  bypass?: string[]
  [key: string]: unknown
}

export const proxy: PluginFactory<ProxyOptions> = definePlugin<ProxyOptions>({
  kind: 'launch',
  name: 'proxy',
  defaults: { url: '' },
  setup(options, ctx) {
    if (!options.url) {
      throw new Error('proxy() needs a url, e.g. http://user:pass@host:8080')
    }
    const url = new URL(options.url)
    const { username, password } = url
    // A proxy that lands the session in another country and leaves the browser
    // asking for the profile's language is the incoherence the profile exists to
    // prevent, so the persona's locale is carried through here too.
    const flags = [
      `--proxy-server=${url.protocol}//${url.host}`,
      `--lang=${ctx.profile.locale}`,
    ]
    if (options.bypass?.length) {
      flags.push(`--proxy-bypass-list=${options.bypass.join(';')}`)
    }
    return {
      flags,
      auth: username ? { username, password } : undefined,
    }
  },
})

export default proxy
