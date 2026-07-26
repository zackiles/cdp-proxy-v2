/** Throwaway: the display claim, with and without a viewport of the client's own. */

import { Config } from '../src/config.ts'
import { harness } from '../src/harness.ts'
import { shutdown } from '../src/sdk.ts'
import { screen as claim } from '../plugins/surface/display/screen.ts'

Config.setGlobal(
  new Config(
    await Config.create({
      CDP_HEADLESS: 'true',
      CDP_PROXY_HOST: 'localhost',
      CDP_BROWSER_HOST: 'localhost',
      CDP_PROXY_LOG_LEVEL: 'error',
    }),
  ),
)

const probe = () => ({
  screen: `${screen.width}x${screen.height}`,
  inner: `${innerWidth}x${innerHeight}`,
  outer: `${outerWidth}x${outerHeight}`,
  gap: outerHeight - innerHeight,
})

{
  await using it = await harness({ plugins: [claim()] })
  const want = it.profile
  console.log(
    'claims',
    `${want.screen.width}x${want.screen.height}`,
    'chrome',
    want.chromeHeight,
    'viewport',
    `${want.viewport.width}x${want.viewport.height}`,
  )
  console.log('default viewport', await it.page.eval(probe))

  await it.page.raw.setViewportSize({ width: 900, height: 700 })
  console.log('after resize    ', await it.page.eval(probe))

  const page = await it.browser.newPage({ viewport: null })
  await page.goto('about:blank')
  console.log(
    'viewport: null  ',
    await page.evaluate(probe),
  )
  await page.close()
}

await shutdown()
