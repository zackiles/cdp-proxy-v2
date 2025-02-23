async function killProcessByPort(port: number): Promise<void> {
  if (!port) return Promise.resolve();
  try {
    if (Deno.build.os === 'windows') {
      const netstatCmd = await new Deno.Command('netstat', { args: ['-ano'] }).output();
      const pid = new TextDecoder()
        .decode(netstatCmd.stdout)
        .split('\n')
        .find(line => line.includes(`:${port}`))
        ?.trim()
        .split(/\s+/)
        .pop();

      if (pid) {
        await new Deno.Command('taskkill', { args: ['/F', '/PID', pid] })
          .output()
          .catch(e => console.debug(`Failed to kill PID ${pid}:`, e));
      }

      await new Deno.Command('taskkill', { args: ['/F', '/IM', 'chrome.exe'] })
        .output()
        .catch(e => !(e instanceof Deno.errors.NotFound) && console.warn('Error killing browser:', e));
    } else {
      await new Deno.Command('pkill', {
        args: ['-f', `(chrome|chromium).*--remote-debugging-port=${port}`],
      })
        .output()
        .catch(e => !(e instanceof Deno.errors.NotFound) && console.warn('Error killing browser:', e));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.warn('Error killing browser process:', error);
    }
  }
}

export { killProcessByPort }