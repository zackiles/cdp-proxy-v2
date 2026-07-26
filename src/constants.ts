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
 * The baseline launch flags live in `src/core/flags.ts` (§8.3), and the reserved
 * and warn lists that used to be documented here are enforced in `src/launch.ts`
 * (§3.1). What was three tiers of prose and one tier of code is now one plugin,
 * pinned first, and one merge.
 */

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
  CDP_HTTP_PATHS,
  CDP_HTTP_PATHS_TO_REWRITE,
  CDP_WEBSOCKET_PATHS,
  HEADLESS_FLAG,
  PROXY_TO_CDP_LOG_LEVEL,
  PROXY_TO_LAUNCHER_LOG_LEVEL,
}
