/**
 * Which `@earendil-works/pi-ai` copy this provider resolved, and which context
 * shape that copy consumes.
 *
 * The two published generations differ: modern (0.86+, including every 1.x)
 * normalizes requests into a transcript whose leading `role: 'system'` message
 * carries the prompt and tool declarations, while legacy (≤0.85) consumes the
 * `{ systemPrompt, tools, messages }` shape and has no branch for a system
 * message inside `messages`. Handing either generation the other shape is a
 * crash or a silent loss of the prompt, so the adapter folds/lifts the context
 * according to the copy this provider resolved — not the host's.
 *
 * The version is the primary signal (numeric semver: major >= 1 or minor >= 86
 * is modern); the package layout (`dist/utils/transcript.js`) is the fallback
 * when no version can be read. Neither probe uses `import.meta.resolve()`,
 * because bundler-style resolvers return a path without checking existence.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The context generation a resolved pi-ai api module speaks. */
export type PiAiGeneration = 'legacy' | 'modern'

/** What {@link piAiRuntimeInfo} reports about the resolved pi-ai copy. */
export interface PiAiRuntimeInfo {
  /** `modern` (0.86+: consumes normalized transcripts) or `legacy` (≤0.85 shape). */
  generation: PiAiGeneration
  /** Version of the resolved copy, when the manifest could be read. */
  version: string | undefined
  /** Package directory of the resolved copy, when it could be located. */
  resolvedFrom: string | undefined
  /**
   * Whether the copy could be inspected at all. `false` means pi-ai does not
   * resolve from this provider — the normal state of a probe run outside the
   * DSH host, where the host supplies the module at plugin runtime.
   * Inside DSH the copy is always inspectable: a nested one shadows host
   * injection, and without a nested one the host supplies its own.
   */
  inspected: boolean
}

let cached: PiAiRuntimeInfo | undefined

/** Resolve (once) which pi-ai copy this provider runs against. */
export function piAiRuntimeInfo(): PiAiRuntimeInfo {
  cached ??= inspectResolvedPiAi()
  return cached
}

function inspectResolvedPiAi(): PiAiRuntimeInfo {
  const entry = resolveModuleFile()
  const root = entry === undefined ? undefined : findPackageRoot(entry)
  const version = root === undefined ? undefined : readVersion(root)
  const transcriptPresent = root === undefined ? undefined : hasTranscriptModule(root)
  return {
    generation: decidePiAiGeneration(version, transcriptPresent),
    version,
    resolvedFrom: root,
    inspected: root !== undefined,
  }
}

/**
 * The generation decision table, exported so every branch is pinned by tests —
 * including the two a development tree cannot reach (no local copy, and a copy
 * with no readable version), which are exactly the states a host install can
 * present.
 *
 * @param version - manifest version of the resolved copy, if readable.
 * @param transcriptPresent - whether that copy actually ships
 * `dist/utils/transcript.js`; `undefined` when nothing was inspected.
 */
export function decidePiAiGeneration(
  version: string | undefined,
  transcriptPresent: boolean | undefined,
): PiAiGeneration {
  const byVersion = generationOf(version)
  if (byVersion !== undefined) return byVersion
  // No readable version: fall back to what the package layout actually contains.
  if (transcriptPresent === true) return 'modern'
  if (transcriptPresent === false) return 'legacy'
  // Not inspectable: outside the host there is no local copy, and every host
  // that normalizes contexts also ships the modern generation. Pass-through is
  // also the safe answer — it cannot destroy an already-correct context, and a
  // standalone probe never reaches a stream call to fold for. Choosing `legacy`
  // here would fold for a copy that may well be modern, deleting the only
  // carrier of the prompt and the tools.
  return 'modern'
}

/**
 * The generation a version string belongs to, or `undefined` when the string
 * cannot be read as a version at all.
 *
 * Only the minor of the `0.x` line matters for the boundary, and `major >= 1`
 * is modern by definition (1.0.x is already in use by `dsh-llm-pi-ai@0.2.1-alpha.2`
 * and consumes transcripts natively).
 */
export function generationOf(version: string | undefined): PiAiGeneration | undefined {
  if (version === undefined) return undefined
  const match = /^(\d+)\.(\d+)\./u.exec(version)
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major > 0) return 'modern'
  return minor >= 86 ? 'modern' : 'legacy'
}

/**
 * Whether the resolved package actually contains the transcript module.
 *
 * `dist/utils/transcript.js` is the file every modern generation ships and no
 * legacy one has (checked: absent in 0.82.1 and 0.85.1; present in 0.86.0,
 * 0.86.1, 0.87.1 and 1.0.2). Landing on the file directly, rather than asking a
 * resolver to find it, is what keeps this honest under bundler-style resolution
 * — see the module docstring.
 */
function hasTranscriptModule(packageRoot: string): boolean {
  return existsSync(join(packageRoot, 'dist', 'utils', 'transcript.js'))
}

/**
 * The file the main entry resolved to; undefined when resolution itself fails.
 *
 * `import.meta.resolve` (not `require.resolve`): pi-ai's exports map exposes
 * "." under the `import` condition only, so the CJS resolver refuses the bare
 * specifier outright — the ESM resolver is the one this provider actually imports
 * with, so it is also the one whose answer is meaningful here. Only the package
 * LOCATION is taken from it; the generation question is answered from disk.
 */
function resolveModuleFile(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'))
  } catch {
    return undefined
  }
}

/**
 * The package directory owning `moduleFile`: `dist/index.js` sits directly
 * inside the package, so walking up from the entry finds its manifest. The
 * manifest is claimed only when its `name` matches, so a same-named ancestor (a
 * pnpm virtual-store parent, for instance) cannot be misread.
 */
function findPackageRoot(moduleFile: string): string | undefined {
  let directory = dirname(moduleFile)
  for (let depth = 0; depth < 4; depth++) {
    if (readManifest(directory)?.name === '@earendil-works/pi-ai') return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
  return undefined
}

/** Version from the manifest already located by {@link findPackageRoot}. */
function readVersion(packageRoot: string): string | undefined {
  const version = readManifest(packageRoot)?.version
  return typeof version === 'string' ? version : undefined
}

function readManifest(directory: string): { name?: unknown, version?: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as { name?: unknown, version?: unknown } : undefined
  } catch {
    // No manifest here (or not JSON): the caller keeps walking up.
    return undefined
  }
}
