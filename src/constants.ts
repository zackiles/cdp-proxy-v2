/**
 * @module constants
 * @description Core configuration constants for Chrome DevTools Protocol (CDP) proxy.
 * @packageDocumentation Contains endpoint paths, browser launch flags, and logging level mappings.
 */

/**
 * HTTP endpoints exposed by the Chrome DevTools Protocol.
 * These endpoints provide various debugging and inspection capabilities.
 * @constant
 * @type {readonly string[]}
 * @example
 * // Access version information
 * '/json/version'
 * // Create new tab
 * '/json/new'
 */
const CDP_HTTP_PATHS = [
  '/json',  // Main endpoint for listing available targets
  '/json/list',  // Alias for /json
  '/json/version',  // Browser version information
  '/json/protocol',  // Full protocol description
  '/json/new',  // Create new tab
  '/json/activate',  // Activate a target
  '/json/close',  // Close a target
  '/devtools/inspector.html',  // DevTools UI
  '/devtools/remote',  // Remote debugging endpoint
] as const

/**
 * WebSocket endpoints for real-time debugging communication.
 * These endpoints enable bidirectional communication for various debugging scenarios.
 * @constant
 * @type {readonly string[]}
 * @see {@link CDP_HTTP_PATHS} for HTTP endpoints
 */
const CDP_WEBSOCKET_PATHS = [
  '/devtools/browser',  // WebSocket endpoint for browser-level debugging
  '/devtools/page',  // WebSocket endpoint for page-level debugging
  '/devtools/inspector',  // WebSocket endpoint for inspector tools
] as const

/**
 * User configurable flags used by the proxy to launch the browser. Most browser
 * flags are available to be configured except for a few reserved flags the proxy 
 * or chrome-launcher (the library that manages the process) needs to launch and 
 * control the browser.
 * 
 * Flag Types:
 * 1. Default Flags: set by the proxy or chrome-launcher. Any matching User Confgurable flags and their values will override them.
 * 2. Reserved Flags: set internally by the proxy or chrome-launcher. Cannot be overriden. Providing one here will throw an error at runtime.
 * 3. User Configurable Flags: set them here. Will override Default Flags and their values.
 * 
 * NOTE: There can be no guarentee what final flags the browser will actually be launched with. These are not necessarily the final flags the browser launches with.
 * Even if there was, the browser's runtime behavior regarding flags can be complex and may not exactly match or respect all flags, and some flags may interact with others in unknown ways.
 * @constant
 * @type {readonly string[]}
 * @see {@link docs/chromium-launch-flags.json} for a comprehensive list of available Chromium/Chrome flags and their descriptions
 * @see {@link browser-manager.ts#simulateFinalLaunchFlags} for debugging purposes, attempts to accurately simulate what the final flags sent to the browser would be.
 */
const BROWSER_LAUNCH_FLAGS = [
  '--headless=new',                // Run browser in headless mode using new implementation
  '--no-default-browser-check',    // Skip default browser check
  '--no-first-run',               // Skip first run wizards
  '--disable-gpu',                // Disable GPU hardware acceleration
  '--disable-accelerated-video-decode', // Disable hardware video decode acceleration
  '--no-sandbox',                 // Disable sandbox security feature
  '--enable-logging',             // Enable browser process logging
  '--enable-features=NetworkService,NetworkServiceInProcess', // Enable required network features
  '--allow-pre-commit-input',     // Allow input before commit
  '--disable-background-networking', // Disable background network tasks
  '--disable-default-apps',       // Disable installation of default apps
  '--disable-extensions',         // Disable browser extensions
  '--disable-sync',              // Disable browser sync features
  '--enable-automation',         // Enable automation-specific features
  '--password-store=basic',      // Use basic password store
] as const

/**
 * Maps proxy application's runtime log level to browser process verbosity flags.
 * @constant
 * @type {Record<string, string>}
 * @property {string} silent '--v=0' - No logs (not even errors)
 * @property {string} error '--v=1' - Errors only
 * @property {string} warn '--v=1' - Errors and warnings
 * @property {string} info '--v=1' - Normal operational logs (includes errors)
 * @property {string} debug '--v=2' - Detailed debugging information (includes errors)
 * @property {string} log '--v=1' - Standard logging level (includes errors)
 * @property {string} verbose '--v=3' - Most detailed logging (includes errors)
 * @see CDP_LOG_LEVEL environment variable for setting the log level
 */
const PROXY_TO_CDP_LOG_LEVEL = {
  silent: '--v=0',   // No logs (not even errors)
  error: '--v=1',    // Errors only
  warn: '--v=1',     // Errors and warnings
  info: '--v=1',     // Normal operational logs (includes errors)
  debug: '--v=2',    // Detailed debugging information (includes errors)
  log: '--v=1',      // Standard logging level (includes errors)
  verbose: '--v=3'   // Most detailed logging (includes errors)
}

/**
 * Maps proxy's log levels to chrome-launcher's expected log levels.
 * This mapping ensures compatibility between our more granular logging system
 * and chrome-launcher's simpler logging interface.
 * @constant
 * @type {Record<string, "silent" | "error" | "warn" | "info" | "verbose">}
 */
const PROXY_TO_LAUNCHER_LOG_LEVEL = {
  silent: "silent",   // No logs
  error: "error",     // Errors only
  warn: "warn",       // Warnings and errors
  info: "info",       // Normal operational logs
  debug: "verbose",   // Maps to verbose for detailed output
  log: "info",        // Maps to info for standard logging
  verbose: "verbose"  // Most detailed logging
} as const

export { 
  CDP_HTTP_PATHS, 
  CDP_WEBSOCKET_PATHS, 
  BROWSER_LAUNCH_FLAGS, 
  PROXY_TO_CDP_LOG_LEVEL,
  PROXY_TO_LAUNCHER_LOG_LEVEL 
}