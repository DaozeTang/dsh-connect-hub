import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLI_MACHINE_ID_SEGMENTS = ['.qoder', '.auth', 'machine_id'] as const

/**
 * Where Qoder's desktop CLI keeps the machine id it generated.
 *
 * The transport only ever reads this file: reusing the CLI's identity keeps the
 * device stable upstream, while the directory itself belongs to the official
 * client and is never written.
 */
export function officialMachineIdPath(): string {
  return join(homedir(), ...CLI_MACHINE_ID_SEGMENTS)
}

/** Read one candidate id, treating any read failure as "not available". */
function storedIdAt(path: string): string | undefined {
  try {
    const value = readFileSync(path, 'utf8').trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** The first non-empty id found along the read chain. */
export function readMachineId(paths: readonly string[]): string | undefined {
  for (const path of paths) {
    const value = storedIdAt(path)
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * An id for this process: an existing trusted one, or a fresh random one.
 *
 * Persisting a generated id is the caller's job; this helper never writes.
 */
export function getMachineId(paths: readonly string[] = []): string {
  return readMachineId(paths) ?? crypto.randomUUID()
}
