/**
 * Monitors a process ID and resolves when either the process exits or timeout is reached
 * @param {number} pid - Process ID to monitor
 * @param {number} timeout - Maximum wait time in milliseconds
 * @returns {Promise<void>} Resolves when process exits or timeout occurs
 * @example
 * await waitForProcessExit(12345, 5000);
 */
async function waitForProcessExit(pid: number, timeout: number): Promise<void> {
  const POLL_INTERVAL = 100;
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    try {
      Deno.kill(pid, undefined)
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
    } catch {
      return
    }
  }
}

export { waitForProcessExit }