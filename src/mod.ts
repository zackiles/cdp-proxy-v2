/**
 * @module cdp-proxy
 * @description Public entry point.
 *
 * Two audiences, two surfaces:
 *
 * - **Automators** want stock Playwright objects that are already stealthy:
 *   `import { chromium } from './src/mod.ts'` then `chromium.launch()`. Stealth
 *   is on by default; `plugins: [...]` replaces the set, `plugins: []` opts out.
 * - **Plugin authors** want to manipulate CDP without forking anything:
 *   `definePlugin({ name, setup(cfg, ctx) { ... } })`.
 *
 * Running the proxy as a standalone server is `Proxy`; `src/main.ts` is a thin
 * wrapper around it.
 */

export { chromium, rpc, shutdown } from './sdk.ts'
export type { Hello, LaunchOptions, RPC, Session, Snapshot } from './sdk.ts'

export { definePlugin } from './plugin.ts'
export { Proxy } from './proxy.ts'
export type { ProxyOptions } from './proxy.ts'

export { Config } from './config.ts'
export type { ConfigOptions } from './config.ts'

export { stealth } from '../plugins/stealth.ts'
export type { StealthOptions } from '../plugins/stealth.ts'

export { recorder } from '../plugins/recorder.ts'
export type { Entry, RecorderOptions } from '../plugins/recorder.ts'

export type {
  CDPDocument,
  CDPEvent,
  CDPRequest,
  CDPResponse,
  CDPTarget,
  ConfiguredPlugin,
  IsolationMode,
  PluginContext,
  PluginDefinition,
  PluginFactory,
  PluginHooks,
  RequestOutcome,
  SessionToken,
} from './types.ts'
