import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PiAiRuntime {
  version: string | undefined
  generation: 'modern' | 'legacy' | 'unknown'
}

const MODERN_MIN_VERSION = [0, 86, 0] as const

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

async function readNearestManifest(entry: string): Promise<string | undefined> {
  let directory = dirname(entry)
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const parsed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
      if (parsed.name === '@earendil-works/pi-ai' && typeof parsed.version === 'string') return parsed.version
    } catch {
      // Keep walking; the dependency root is a few levels above dist/.
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/** Injectable seams so the generation classifier is testable without a install. */
export interface DetectPiAiRuntimeOptions {
  /** Module resolution; defaults to `import.meta.resolve`. */
  resolve?: (specifier: string) => string
  /** Manifest reader; defaults to the nearest-package.json walk. */
  readManifest?: (entry: string) => Promise<string | undefined>
}

export async function detectPiAiRuntime(options: DetectPiAiRuntimeOptions = {}): Promise<PiAiRuntime> {
  const resolve = options.resolve ?? ((specifier: string): string => import.meta.resolve(specifier))
  const readManifest = options.readManifest ?? readNearestManifest
  try {
    const entry = resolve('@earendil-works/pi-ai')
    const version = await readManifest(fileURLToPath(entry))
    if (version === undefined) return { version: undefined, generation: 'unknown' }
    const parsed = parseVersion(version)
    return {
      version,
      generation: parsed !== undefined && compare(parsed, MODERN_MIN_VERSION) >= 0 ? 'modern' : 'legacy',
    }
  } catch {
    return { version: undefined, generation: 'unknown' }
  }
}
