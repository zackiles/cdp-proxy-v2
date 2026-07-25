/**
 * @module constants
 * @description Core configuration constants for Chrome DevTools Protocol (CDP) proxy.
 * @packageDocumentation Contains endpoint paths, browser launch flags, and logging level mappings.
 */

/**
 * HTTP endpoints exposed by the Chrome DevTools Protocol.
 * These endpoints provide various debugging and inspection capabilities.
 */
const CDP_HTTP_PATHS = [
  '/json', // Main endpoint for listing available targets
  '/json/list', // Alias for /json
  '/json/version', // Browser version information
  '/json/protocol', // Full protocol description
  '/json/new', // Create new tab
  '/json/activate', // Activate a target
  '/json/close', // Close a target
  '/devtools/inspector.html', // DevTools UI
] as const

/**
 * HTTP endpoints that contain the wsWebSocketDebuggerUrl field in their response.
 * These paths require URL rewriting to ensure the WebSocket URLs reference the proxy's
 * host and port instead of the browser's, maintaining proxy transparency.
 */
const CDP_HTTP_PATHS_TO_REWRITE = [
  '/json/version', // Contains WebSocket debugger URL
  '/json', // Contains WebSocket debugger URLs for all targets
  '/json/list', // Contains WebSocket debugger URLs for all targets
  '/json/new', // Contains WebSocket debugger URL for new target
] as const

/**
 * WebSocket endpoints for real-time debugging communication.
 * These endpoints enable bidirectional communication for various debugging scenarios.
 * @see {@link CDP_HTTP_PATHS} for HTTP endpoints
 */
const CDP_WEBSOCKET_PATHS = [
  '/devtools/browser', // WebSocket endpoint for browser-level debugging
  '/devtools/page', // WebSocket endpoint for page-level debugging
] as const

/**
 * User configurable flags used by the proxy to launch the browser.
 * Most browser flags are available to be configured except for a few reserved flags the proxy
 * or chrome-launcher needs to launch and control the browser.
 *
 * Flag Types:
 * 1. Default Flags: Set by proxy/chrome-launcher. Can be overridden by User Configurable flags
 * 2. Reserved Flags: Set internally, cannot be overridden. Will throw runtime error if provided
 * 3. User Configurable Flags: Override Default Flags when specified
 *
 * NOTE: Final browser launch flags may vary due to browser runtime behavior and flag interactions.
 * @see {@link docs/chromium-launch-flags.json} for available Chromium flags
 * @see {@link browser-manager.ts#simulateFinalLaunchFlags} for launch flag simulation
 */
const BROWSER_LAUNCH_FLAGS = [
  '--no-default-browser-check', // Skip default browser check
  '--no-first-run', // Skip first run wizards
  '--disable-gpu', // Disable GPU hardware acceleration
  '--disable-accelerated-video-decode', // Disable hardware video decode acceleration
  '--no-sandbox', // Disable sandbox security feature
  '--enable-features=NetworkService,NetworkServiceInProcess', // Enable required network features
  '--allow-pre-commit-input', // Allow input before commit
  '--disable-background-networking', // Disable background network tasks
  '--disable-default-apps', // Disable installation of default apps
  '--disable-extensions', // Disable browser extensions
  '--disable-sync', // Disable browser sync features
  '--password-store=basic', // Use basic password store
] as const

// DANGER: --enable-automation is intentionally omitted. It sets
// navigator.webdriver=true and shows the automation infobar, both of which are
// stealth tells that defeat the product's core purpose.

/** Appended only when running headless; kept conditional per §0.1.3 / §9. */
const HEADLESS_FLAG = '--headless=new'

type ProxyLogLevel =
  | 'silent'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug'
  | 'log'
  | 'verbose'

type LauncherLogLevel = 'silent' | 'error' | 'warn' | 'info' | 'verbose'

/**
 * Maps proxy log levels to the browser's log level (passed as a launch flag).
 */
const PROXY_TO_CDP_LOG_LEVEL: Record<ProxyLogLevel, string> = {
  silent: '--v=0', // No logs
  error: '--v=1', // Errors only
  warn: '--v=1', // Errors and warnings
  info: '--v=1', // Normal operational logs
  debug: '--v=2', // Detailed debugging information
  log: '--v=1', // Standard logging level
  verbose: '--v=3', // Most detailed logging
} as const

/**
 * Maps proxy log levels to chrome-launcher log levels (passed to the chrome-launcher launch() method).
 * Provides compatibility between proxy's granular logging and chrome-launcher's simpler interface.
 */
const PROXY_TO_LAUNCHER_LOG_LEVEL: Record<ProxyLogLevel, LauncherLogLevel> = {
  silent: 'silent', // No logs
  error: 'error', // Errors only
  warn: 'warn', // Warnings and errors
  info: 'info', // Normal operational logs
  debug: 'verbose', // Maps to verbose for detailed output
  log: 'info', // Maps to info for standard logging
  verbose: 'verbose', // Most detailed logging
} as const

export {
  BROWSER_LAUNCH_FLAGS,
  CDP_HTTP_PATHS,
  CDP_HTTP_PATHS_TO_REWRITE,
  CDP_WEBSOCKET_PATHS,
  HEADLESS_FLAG,
  PROXY_TO_CDP_LOG_LEVEL,
  PROXY_TO_LAUNCHER_LOG_LEVEL,
}
