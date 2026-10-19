import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from '../../core/atomic.ts'
import type { TraeModelInfo } from './catalog.ts'
import { TRAE_REASONING_EFFORTS, type TraeReasoningEffort } from './reasoning.ts'
import type { TraeRegion } from './region.ts'

/** Current on-disk format of the cached catalog. */
export const TRAE_CATALOG_CACHE_VERSION = 1

export interface TraeCatalogCache {
  version: 1
  region: TraeRegion
  updatedAt: number
  models: TraeModelInfo[]
}

const KNOWN_EFFORTS: ReadonlySet<string> = new Set(TRAE_REASONING_EFFORTS)
const INPUT_KINDS: ReadonlySet<string> = new Set(['text', 'image'])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Positive integer token counts; fractions are floored and non-positive values dropped. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function decodeReasoning(value: unknown): TraeModelInfo['reasoning'] | undefined {
  const row = asRecord(value)
  if (row === undefined) return undefined
  const rawSupported = row['supported']
  if (!Array.isArray(rawSupported)) return undefined
  const supported: TraeReasoningEffort[] = []
  for (const entry of rawSupported) {
    if (typeof entry === 'string' && KNOWN_EFFORTS.has(entry)) supported.push(entry as TraeReasoningEffort)
  }
  if (supported.length === 0) return undefined
  const rawDefault = row['defaultEffort']
  const defaultEffort = typeof rawDefault === 'string' && KNOWN_EFFORTS.has(rawDefault)
    ? rawDefault as TraeReasoningEffort
    : undefined
  return defaultEffort === undefined ? { supported } : { supported, defaultEffort }
}

/** Decode one cached model row, dropping rows that lost their identity. */
function decodeModel(value: unknown): TraeModelInfo | undefined {
  const row = asRecord(value)
  if (row === undefined) return undefined
  const id = row['id']
  if (typeof id !== 'string' || id === '') return undefined
  const displayName = row['name']
  const contextWindow = tokenCount(row['contextWindow'])
  const maxTokens = tokenCount(row['maxTokens'])
  const maxContextWindow = tokenCount(row['maxContextWindow'])
  const multiplier = row['creditMultiplier']
  const rawInput = Array.isArray(row['input']) ? row['input'] : []
  const inputs: ('text' | 'image')[] = []
  for (const entry of rawInput) {
    if (typeof entry === 'string' && INPUT_KINDS.has(entry)) inputs.push(entry as 'text' | 'image')
  }
  const reasoning = decodeReasoning(row['reasoning'])
  const wireName = row['wireConfigName']
  const wireFunction = row['wireFunction']
  const multimodal = row['multimodal']
  return {
    id,
    name: typeof displayName === 'string' && displayName !== '' ? displayName : id,
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...maxContextWindow === undefined ? {} : { maxContextWindow },
    ...typeof multiplier === 'number' && Number.isFinite(multiplier) ? { creditMultiplier: multiplier } : {},
    input: inputs.length === 0 ? ['text'] : inputs,
    reasoningSupported: row['reasoningSupported'] === true,
    ...reasoning === undefined ? {} : { reasoning },
    ...typeof wireName === 'string' && wireName !== '' ? { wireConfigName: wireName } : {},
    ...typeof wireFunction === 'string' && wireFunction !== '' ? { wireFunction } : {},
    ...multimodal === true ? { multimodal: true } : multimodal === false ? { multimodal: false } : {},
  }
}

/** Decode a persisted cache document, or undefined when it is unusable. */
export function parseTraeCatalogCache(value: unknown): TraeCatalogCache | undefined {
  const row = asRecord(value)
  if (row === undefined) return undefined
  if (row['version'] !== TRAE_CATALOG_CACHE_VERSION) return undefined
  const region = row['region']
  if (region !== 'cn' && region !== 'ai') return undefined
  const updatedAt = tokenCount(row['updatedAt'])
  if (updatedAt === undefined) return undefined
  const rawModels = row['models']
  if (!Array.isArray(rawModels)) return undefined
  const models: TraeModelInfo[] = []
  for (const raw of rawModels) {
    const model = decodeModel(raw)
    if (model !== undefined) models.push(model)
  }
  if (models.length === 0) return undefined
  return { version: TRAE_CATALOG_CACHE_VERSION, region, updatedAt, models }
}

/** Owner-scoped cache file for one region. */
export function traeCatalogCachePath(stateDir: string, region: TraeRegion): string {
  return join(stateDir, `trae-${region}-catalog.json`)
}

export async function loadTraeCatalogCache(
  stateDir: string,
  region: TraeRegion,
): Promise<TraeCatalogCache | undefined> {
  const document = parseTraeCatalogCache(await readJsonFile<unknown>(traeCatalogCachePath(stateDir, region)))
  return document !== undefined && document.region === region ? document : undefined
}

export async function saveTraeCatalogCache(
  stateDir: string,
  region: TraeRegion,
  models: readonly TraeModelInfo[],
  updatedAt: number,
): Promise<void> {
  const document: TraeCatalogCache = {
    version: TRAE_CATALOG_CACHE_VERSION,
    region,
    updatedAt,
    models: models.map(model => ({ ...model })),
  }
  await writeJsonFile(traeCatalogCachePath(stateDir, region), document)
}
