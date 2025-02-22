/**
Deno.env.set('DEBUG', 'pw:protocol')
Deno.env.set('BROWSER_MANAGER_DEBUG', '1')
Deno.env.set('DENO_ENV', 'test')

import { chromium } from '@browser-tools/browser-manager'
 
await chromium.install({
  platform: 'windows',
  arch: 'x64',
  customBasePath: '.cache',
})

console.log('installed')
*/

import { ProxyManager } from './proxy-manager.ts'

const proxy = new ProxyManager()

proxy.createConnection(
  'ws://localhost:9222/devtools/browser/b0b8a4fb-bb17-4359-9533-a8d9f3908bd8',
)
