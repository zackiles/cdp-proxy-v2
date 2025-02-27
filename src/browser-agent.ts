//Deno.env.set('DEBUG', 'pw:api')
import { chromium } from 'playwright'

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
  },
}

async function connectAndNavigate(
  browserWebSocketDebuggerUrl: string,
): Promise<void> {
  // Suppress specific warning about createConnection
  //filterPlaywrightLogs.suppressCreateConnectionWarning()
  console.debug(
    'Attempting to connect to browser through the proxy through Playwright client...',
  )
  // Connect to the existing browser instance using CDP

  const browser = await chromium.connectOverCDP(browserWebSocketDebuggerUrl, {
    slowMo: 10000,
    logger: {
      isEnabled: () => true,
      log: (name, severity, message, args) =>
        console.log(
          `PLAYWRIGHT CLIENT LOG:${severity} ${name} ${message}`,
          args,
        ),
    },
  })
  console.debug('Connected to browser through the proxy over CDP!', {
    browserWebSocketDebuggerUrl,
  })
  // Create a new context
  const context = await browser.newContext()
  console.debug('Created a new context!')

  // Create a new page and navigate to about:blank first
  const page = await context.newPage()
  console.debug('Created a new page!')
  await page.goto('about:blank', { waitUntil: 'networkidle' })
  console.debug('Navigated to about:blank!')

  // Navigate to Google and wait for network idle
  await page.goto('https://www.google.com', { waitUntil: 'networkidle' })
  console.debug('Navigated to Google!')
  // Get the page title and verify it
  const pageTitle = await page.title()
  console.debug('Got the page title!', { pageTitle })
  if (!pageTitle.toLowerCase().includes('google')) {
    throw new Error(`Expected Google page title but got: ${pageTitle}`)
  }

  await new Promise((resolve) => setTimeout(resolve, 30000))
  //console.debug('Closing the context...')
  // Clean up context only, let ShutdownManager handle browser cleanup
  //await context.close()
  // console.debug('Closed the context!')
}

export { connectAndNavigate }
