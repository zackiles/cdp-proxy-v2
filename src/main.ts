/**
 * @module main
 * @description Standalone entry point: load config, start the proxy core. The
 * proxy fronts a managed or remote browser and serves the CDP HTTP/WS surface.
 * Automators normally use the client SDK (`sdk.ts`) instead of running this.
 */

import { Config } from './config.ts'
import { Proxy } from './proxy.ts'
import { Logger } from './logger.ts'

async function main(): Promise<void> {
  const options = await Config.create(await Config.env())
  // The standalone server is batteries-included: remote clients register plugin
  // sets by name over the control endpoint, so the bundled ones must be loaded.
  Config.setGlobal(
    new Config({
      ...options,
      pluginsDirectory: options.pluginsDirectory || 'plugins',
    }),
  )

  Logger.get('main').info('config initialized', {
    proxyPort: Config.get('proxyPort'),
    proxyHost: Config.get('proxyHost'),
    browserPort: Config.get('browserPort'),
    headless: Config.get('headless'),
    isolation: Config.get('isolation'),
    browser: Config.get('browserWsEndpoint') ||
      Config.get('browserExecutablePath'),
  })

  const proxy = new Proxy()
  await proxy.start()
}

if (import.meta.main) {
  await main()
}
