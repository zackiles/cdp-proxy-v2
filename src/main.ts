Deno.env.set('DEBUG', 'pw:protocol')
Deno.env.set('BROWSER_MANAGER_DEBUG', '1')
Deno.env.set('DENO_ENV', 'test')

import { chromium } from '@browser-tools/browser-manager'

const url = await chromium.getDownloadUrl({
  platform: 'windows',
  arch: 'x64',
})
console.log(url)
await chromium.install({
  platform: 'windows',
  arch: 'x64',
  customBasePath: '.cache',
})
