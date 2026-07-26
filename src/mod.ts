/**
 * @module cdp-proxy
 * @description Public entry point.
 *
 * Two audiences, two surfaces:
 *
 * - **Automators** want stock Playwright objects that are already stealthy:
 *   `import { chromium } from './src/mod.ts'` then `chromium.launch()`. Stealth
 *   is on by default; `plugins: [...]` replaces the authored set, `plugins: []`
 *   leaves only core, and `plugins: 'none'` is a transparent relay (§8.6).
 * - **Plugin authors** want to manipulate CDP without forking anything:
 *   `definePlugin({ kind, name, setup(cfg, ctx) { ... } })`. One constructor
 *   builds all five kinds and `kind` selects which one.
 *
 * Running the proxy as a standalone server is `Proxy`; `src/main.ts` is a thin
 * wrapper around it.
 */

export { chromium, rpc, shutdown } from './sdk.ts'
export type {
  Hello,
  Identity,
  LaunchOptions,
  RPC,
  Session,
  Snapshot,
} from './sdk.ts'

export { definePlugin, definePreset } from './plugin.ts'
export { Proxy } from './proxy.ts'
export type { ProxyOptions } from './proxy.ts'

export { harness } from './harness.ts'
export type { Harness, HarnessOptions, HarnessPage, Wire } from './harness.ts'

export { Config } from './config.ts'
export type { ConfigOptions } from './config.ts'

export { stealth } from '../plugins/stealth.ts'
export type { StealthOptions } from '../plugins/stealth.ts'

// The surfaces `stealth()` expands to, exported so a caller can compose their
// own set — `plugins: [navigator(), webgl()]` is a supported thing to write.
export { navigator } from '../plugins/surface/platform/navigator.ts'
export type { NavigatorOptions } from '../plugins/surface/platform/navigator.ts'
export { chrome } from '../plugins/surface/platform/chrome.ts'
export type { ChromeOptions } from '../plugins/surface/platform/chrome.ts'
export { fonts } from '../plugins/surface/platform/fonts.ts'
export type { FontsOptions } from '../plugins/surface/platform/fonts.ts'
export { canvas } from '../plugins/surface/graphics/canvas.ts'
export type { CanvasOptions } from '../plugins/surface/graphics/canvas.ts'
export { webgl } from '../plugins/surface/graphics/webgl.ts'
export type { WebglOptions } from '../plugins/surface/graphics/webgl.ts'
export { timezone } from '../plugins/surface/locale/timezone.ts'
export type { TimezoneOptions } from '../plugins/surface/locale/timezone.ts'
export { geo } from '../plugins/surface/locale/geo.ts'
export type { GeoOptions } from '../plugins/surface/locale/geo.ts'
export { audio } from '../plugins/surface/media/audio.ts'
export type { AudioOptions } from '../plugins/surface/media/audio.ts'
export { codecs } from '../plugins/surface/media/codecs.ts'
export type { CodecsOptions } from '../plugins/surface/media/codecs.ts'
export { devices } from '../plugins/surface/media/devices.ts'
export type { DevicesOptions } from '../plugins/surface/media/devices.ts'
export { webrtc } from '../plugins/surface/network/webrtc.ts'
export type { WebrtcOptions } from '../plugins/surface/network/webrtc.ts'
export { permissions } from '../plugins/surface/permissions.ts'
export type { PermissionsOptions } from '../plugins/surface/permissions.ts'
export { battery } from '../plugins/surface/battery.ts'
export type { BatteryOptions } from '../plugins/surface/battery.ts'
export { screen } from '../plugins/surface/display/screen.ts'
export type { ScreenOptions } from '../plugins/surface/display/screen.ts'

export { pin } from '../plugins/profile/pin.ts'
export type { PinOptions } from '../plugins/profile/pin.ts'
export { corpus } from '../plugins/profile/corpus.ts'
export type { CorpusOptions } from '../plugins/profile/corpus.ts'
export { remote } from '../plugins/profile/remote.ts'
export type { RemoteOptions } from '../plugins/profile/remote.ts'
export { banner } from '../plugins/actor/banner.ts'
export type { BannerOptions } from '../plugins/actor/banner.ts'
export { captcha } from '../plugins/actor/captcha.ts'
export type { CaptchaOptions, Challenge } from '../plugins/actor/captcha.ts'

// DANGER: each of these costs a browser process per session (§3.3). Flags are
// per-process and plugin sets are per-session, so there is no honest way to put
// one session's `--proxy-server` on a process another session is also using.
export { proxy } from '../plugins/launch/proxy.ts'
export type { ProxyOptions as ProxyPluginOptions } from '../plugins/launch/proxy.ts'
export { clock } from '../plugins/launch/clock.ts'
export type { ClockOptions } from '../plugins/launch/clock.ts'
export { extension } from '../plugins/launch/extension.ts'
export type { ExtensionOptions } from '../plugins/launch/extension.ts'

export { recorder } from '../plugins/protocol/recorder.ts'
export type { Entry, RecorderOptions } from '../plugins/protocol/recorder.ts'

export type {
  ActorDefinition,
  BrowserInfo,
  CDPDocument,
  CDPEvent,
  CDPRequest,
  CDPResponse,
  CDPTarget,
  ConfiguredPlugin,
  Constraint,
  Context,
  Coverage,
  Display,
  Draw,
  InjectOptions,
  IsolationMode,
  Kind,
  LaunchContext,
  LaunchDefinition,
  LaunchHooks,
  LaunchSpec,
  PageContext,
  PluginContext,
  PluginDefinition,
  PluginFactory,
  PluginHooks,
  PluginList,
  PluginSet,
  PresetDefinition,
  PresetFactory,
  Profile,
  ProfileContext,
  ProfileDefinition,
  ProfileHooks,
  ProtocolDefinition,
  Realm,
  RealmContext,
  RequestOutcome,
  SessionId,
  SessionToken,
  SurfaceContext,
  SurfaceDefinition,
  SurfaceHooks,
  TargetId,
} from './types.ts'
