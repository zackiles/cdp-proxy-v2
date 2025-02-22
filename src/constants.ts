export const CDP_HTTP_PATHS = [
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

export const CDP_WEBSOCKET_PATHS = [
  '/devtools/browser',  // WebSocket endpoint for browser-level debugging
  '/devtools/page',  // WebSocket endpoint for page-level debugging
  '/devtools/inspector',  // WebSocket endpoint for inspector tools
] as const


export const BROWSER_LAUNCH_FLAGS = [
  '--headless=new',
  '--disable-gpu',
  '--disable-accelerated-video-decode',
  '--no-sandbox',
  '--enable-logging',
  '--v=1',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--allow-pre-commit-input',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--enable-automation',
  '--password-store=basic',
] as const
