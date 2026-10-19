import { release } from 'node:os'

/** Environment variables WSL sets for a session, one per supported version. */
const WSL_SESSION_VARIABLES = ['WSL_DISTRO_NAME', 'WSL_INTEROP'] as const

/** Whether any WSL session marker is present in this process. */
function markedByEnvironment(): boolean {
  return WSL_SESSION_VARIABLES.some((name) => process.env[name] !== undefined)
}

/** Whether the running kernel identifies itself as a WSL build. */
function markedByKernel(): boolean {
  return release().toLowerCase().includes('microsoft')
}

/**
 * Whether this Linux process runs inside Windows Subsystem for Linux (either
 * generation). Both the environment markers and the kernel release string are
 * consulted, so a session whose variables were stripped still classifies as
 * WSL.
 */
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  return markedByEnvironment() || markedByKernel()
}
