import { Config } from '../src/config.ts'
import { harness } from '../src/harness.ts'
import { shutdown } from '../src/sdk.ts'
import { audio } from '../plugins/surface/media/audio.ts'
const options = await Config.create({ CDP_HEADLESS: 'true', CDP_PROXY_HOST: 'localhost', CDP_BROWSER_HOST: 'localhost', CDP_PROXY_LOG_LEVEL: 'error' })
Config.setGlobal(new Config(options))
{
  await using it = await harness({ plugins: [audio()], debug: true })
  console.log(await it.page.eval(async () => {
    const ctx = new OfflineAudioContext(1, 1024, 44100)
    const osc = ctx.createOscillator()
    osc.connect(ctx.destination); osc.start(0)
    const buf = await ctx.startRendering()
    const a = buf.getChannelData(0)
    return { first: Array.from(a.slice(100, 103)), patched: buf.getChannelData.toString() }
  }))
  console.log(it.trace)
}
await shutdown(); Deno.exit(0)
