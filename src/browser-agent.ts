import { chromium } from "playwright"

const filterPlaywrightLogs = {
  suppressCreateConnectionWarning() {
    const originalWarn = console.warn
    console.warn = (...args) => {
      if (args[0]?.includes?.('ClientRequest.options.createConnection')) return
      originalWarn.apply(console, args)
    }
    return originalWarn
  },
  
  restore(originalWarn: typeof console.warn) {
    console.warn = originalWarn
  }
}

async function connectAndNavigate(browserWebSocketDebuggerUrl: string): Promise<void> {
  // Suppress specific warning about createConnection
  filterPlaywrightLogs.suppressCreateConnectionWarning()

  // Connect to the existing browser instance using CDP
  const browser = await chromium.connectOverCDP(browserWebSocketDebuggerUrl)
  
  
  // Create a new context
  const context = await browser.newContext()
  
  // Create a new page and navigate to about:blank first
  const page = await context.newPage()
  await page.goto('about:blank', { waitUntil: 'networkidle' })
  
  // Navigate to example.com and wait for network idle
  await page.goto('https://example.com', { waitUntil: 'networkidle' })
  
  // Clean up
  await context.close()
  await browser.close()
}

export { connectAndNavigate }
