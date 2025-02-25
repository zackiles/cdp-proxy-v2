/**
 * Monitors a process ID and resolves when either the process exits or timeout is reached
 * @param {number} pid - Process ID to monitor
 * @param {number} timeout - Maximum wait time in milliseconds
 * @returns {Promise<void>} Resolves when process exits or timeout occurs
 * @example
 * await waitForProcessExit(12345, 5000);
 */
async function waitForProcessExit(pid: number, timeout: number): Promise<void> {
  const POLL_INTERVAL = 100
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    try {
      Deno.kill(pid, undefined) // Doesn't kill a process, only checks if it exists.
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
    } catch {
      return
    }
  }
}

/**
 * Kills a process running on a specific port if its name matches a given regex pattern.
 *
 * This function works cross-platform (Windows, macOS, Linux, WSL) by:
 * - Using `netstat` (Windows) or `lsof` (Unix) to find processes listening on the port.
 * - Matching process names using `tasklist` (Windows) or `ps` (Unix).
 * - Terminating the identified processes using `taskkill` (Windows) or `Deno.kill` (Unix).
 * - Ensuring process termination with a retry mechanism.
 *
 * ### Features:
 * - **Ensures command status is checked before reading output**, avoiding potential crashes.
 * - **Handles long process names in `tasklist` output correctly**.
 * - **Uses batch processing for `taskkill` to avoid CLI length limits**.
 * - **Retries process termination with exponential backoff (capped at 500ms)**.
 *
 * @param {string | number} port - The port number to find and terminate processes on.
 * @param {RegExp} pattern - A regex pattern to match the process name.
 * @returns {Promise<void>} Resolves when all matching processes are terminated.
 * @throws {Error} If critical system commands fail to execute.
 */
async function killProcessOnPortByName(
  port: string | number,
  pattern: RegExp,
): Promise<void> {
  const PORT_STR = String(port)
  const MAX_RETRY_COUNT = 10
  const MAX_BATCH_SIZE = 10
  const MAX_BACKOFF_MS = 500
  const PROCESS_EXIT_TIMEOUT_MS = 5000

  const isWSL =
    Deno.build.os === 'linux' &&
    (await Deno.readTextFile('/proc/version').catch(() => '')).includes(
      'Microsoft',
    )

  const runCommand = async ({ cmd, args }: { cmd: string; args: string[] }) => {
    const process = new Deno.Command(cmd, { args, stdout: 'piped' }).spawn()
    const status = await process.status
    if (!status.success) {
      throw new Error(`Command failed: ${cmd} ${args.join(' ')}`)
    }
    const output = new TextDecoder().decode(
      await new Response(process.stdout).arrayBuffer(),
    )
    return output
  }

  // Get PIDs for processes on the specified port
  const getPids = async (): Promise<string[]> => {
    try {
      if (Deno.build.os === 'windows' && !isWSL) {
        const netstat = new Deno.Command('netstat', {
          args: ['-ano'],
          stdout: 'piped',
          stderr: 'piped',
        }).spawn()

        const status = await netstat.status
        if (!status.success) {
          console.error('Command failed: netstat -ano')
          return []
        }

        const out = new TextDecoder().decode(
          await new Response(netstat.stdout).arrayBuffer(),
        )
        const pids = out
          .split('\n')
          .filter((line) => line.includes(':' + PORT_STR))
          .map((line) => line.trim().split(/\s+/).pop()!)
          .filter(Boolean)

        // Return empty array for no processes - this is not an error
        return pids
      } else {
        try {
          const output = await runCommand({
            cmd: 'lsof',
            args: ['-i', `:${PORT_STR}`, '-sTCP:LISTEN', '-t'],
          })
          const pids = output
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
          return pids
        } catch (error: unknown) {
          // Handle case where lsof returns no output (exit code 1)
          if (
            error instanceof Error &&
            error.message.includes('Command failed')
          ) {
            // No processes found - this is acceptable
            return []
          }
          throw error
        }
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new Error(
        `Failed to get PIDs for port ${PORT_STR}: ${errorMessage}`,
      )
    }
  }

  try {
    const pids = await getPids()
    if (!pids.length) {
      console.debug(`No processes found on port ${PORT_STR}`)
      return // Early return for no processes
    }

    if (Deno.build.os === 'windows' && !isWSL) {
      try {
        // Use /FO CSV to get reliable CSV format output
        const output = await runCommand({
          cmd: 'tasklist',
          args: ['/FO', 'CSV', '/NH'],
        })
        const processMap = output
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .reduce((acc: Record<string, string>, line) => {
            // Parse CSV format - handle quoted strings properly
            const csvParts = line
              .split(',')
              .map((part) => part.trim().replace(/^"|"$/g, ''))
            if (csvParts.length >= 2) {
              const [processName, pid] = csvParts
              acc[pid] = processName
            }
            return acc
          }, {})

        const pidsToKill = pids.filter(
          (pid) => processMap[pid] && pattern.test(processMap[pid]),
        )

        // Process in batches to avoid command line length limits
        for (let i = 0; i < pidsToKill.length; i += MAX_BATCH_SIZE) {
          const batch = pidsToKill.slice(i, i + MAX_BATCH_SIZE)
          await runCommand({
            cmd: 'taskkill',
            args: ['/F', '/T', '/PID', ...batch],
          }).catch((error: unknown) => {
            const errorMessage =
              error instanceof Error ? error.message : String(error)
            console.error('Process kill failed', {
              batchIndex: i,
              error: errorMessage,
            })
          })

          // Verify each process in batch is actually killed
          await Promise.all(
            batch.map(async (pid) => {
              try {
                await waitForProcessExit(Number(pid), PROCESS_EXIT_TIMEOUT_MS)
              } catch {
                console.error(`Process ${pid} failed to exit within timeout`)
                throw new Error(`Process ${pid} failed to exit within timeout`)
              }
            }),
          )

          const processNames = batch.map((pid) => processMap[pid]).join(', ')
          console.debug('Processes killed successfully', {
            processNames,
            port: PORT_STR,
          })
        }
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        console.error(`Windows process termination failed: ${errorMessage}`)
      }
    } else {
      try {
        const processMap: Record<string, string> = {}
        const psOutput = await runCommand({
          cmd: 'ps',
          args: ['-p', pids.join(','), '-o', 'pid,args='],
        })

        const pidToCmdline = Object.fromEntries(
          psOutput
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [pid, ...cmdParts] = line.split(/\s+/)
              return [pid, cmdParts.join(' ')]
            })
            .filter(([, cmd]) => cmd),
        )

        for (const pid of pids) {
          const cmdline = pidToCmdline[pid]
          if (!cmdline || !pattern.test(cmdline)) continue

          const killProcess = async () => {
            try {
              Deno.kill(Number(pid), 'SIGKILL')
            } catch {
              return false
            }
            return true
          }

          // Initial kill attempt
          await killProcess()

          // Retry with exponential backoff if needed
          for (let retryCount = 0; retryCount < MAX_RETRY_COUNT; retryCount++) {
            if (await killProcess()) {
              try {
                await waitForProcessExit(Number(pid), PROCESS_EXIT_TIMEOUT_MS)
              } catch {
                console.error(`Process ${pid} failed to exit within timeout`)
                throw new Error(`Process ${pid} failed to exit within timeout`)
              }

              const logData: Record<string, string | number> = {
                pid,
                port: PORT_STR,
              }

              // Add process name if available (Windows)
              if (processMap[pid]) {
                logData.processName = processMap[pid]
              }
              // Add cmdline if available (Unix)
              if (cmdline) {
                logData.cmdline = cmdline
              }

              console.debug('Process killed successfully', logData)
              break
            }
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.min(MAX_BACKOFF_MS, 2 ** retryCount * 10),
              ),
            )
          }
        }
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        console.error(`Unix process termination failed: ${errorMessage}`)
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(errorMessage)
    throw error
  }
}

/**
 * Converts a `Record<string, string>` into an object with parsed values.
 *
 * This function attempts to parse string values into their appropriate types:
 * - Numbers are converted to numbers
 * - Booleans are converted to booleans
 * - Arrays and objects are parsed from JSON
 * - Everything else remains a string
 *
 * @param {Record<string, string>} record - The record to convert
 * @returns {Record<string, unknown>} The converted object
 * @example
 * const record = {
 *   key1: 'value1',
 *   key2: '42',
 *   key3: 'true',
 *   key4: '[1,2,3]'
 * };
 * const result = recordToObject(record);
 * // result = {
 * //   key1: 'value1',
 * //   key2: 42,
 * //   key3: true,
 * //   key4: [1,2,3]
 * // }
 */
function recordToObject(
  record: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      // Try to parse as number
      if (/^-?\d+(\.\d+)?$/.test(value)) {
        return [key, Number(value)]
      }
      // Try to parse as boolean
      if (value === 'true') return [key, true]
      if (value === 'false') return [key, false]
      // Try to parse as JSON (for arrays and objects)
      try {
        return [key, JSON.parse(value)]
      } catch {
        // If all else fails, keep as string
        return [key, value]
      }
    }),
  )
}

export { waitForProcessExit, killProcessOnPortByName, recordToObject }
