/**
 * Browser-local preferences owned by the client half.
 *
 * Nothing here is durable plugin state (that lives host-side in `deps.prefs`);
 * this file only remembers presentation choices this browser should keep:
 * which composer seat shows the readout, and the last family/region tab.
 */

import type { ProviderFamily, Region } from '../shared/contracts.ts'

export type ComposerSeat = 'toolbar' | 'dock'

export interface ClientPreferences {
  seat: ComposerSeat
  family: ProviderFamily
  region: Region
}

const STORAGE_KEY = 'dsh-connect-hub.preferences.v1'
const DEFAULT_PREFERENCES: ClientPreferences = { seat: 'toolbar', family: 'qoder', region: 'cn' }

/** The two members of `Storage` this module needs; tests pass a plain object. */
export interface PreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function isValidFamily(value: unknown): value is ProviderFamily {
  return value === 'qoder' || value === 'workbuddy' || value === 'trae'
}

function isValidRegion(value: unknown): value is Region {
  return value === 'cn' || value === 'global'
}

function parsePreferences(raw: string | null): ClientPreferences {
  if (raw === null) return { ...DEFAULT_PREFERENCES }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_PREFERENCES }
  const record = value as Record<string, unknown>
  return {
    seat: record['seat'] === 'dock' ? 'dock' : 'toolbar',
    family: isValidFamily(record['family']) ? record['family'] : DEFAULT_PREFERENCES.family,
    region: isValidRegion(record['region']) ? record['region'] : DEFAULT_PREFERENCES.region,
  }
}

/** Storage backed by `localStorage`, or a no-op when the browser denies access. */
function browserStorage(): PreferenceStorage {
  try {
    const storage = globalThis.localStorage
    if (storage !== undefined) return storage
  } catch {
    // Storage disabled by policy: preferences live for this page only.
  }
  const memory = new Map<string, string>()
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => { memory.set(key, value) },
  }
}

/** Observable preference cell shared by the settings page and both readout seats. */
export class ClientPreferencesStore {
  private readonly storage: PreferenceStorage
  private current: ClientPreferences
  private readonly listeners = new Set<() => void>()

  constructor(storage: PreferenceStorage = browserStorage()) {
    this.storage = storage
    let raw: string | null = null
    try {
      raw = storage.getItem(STORAGE_KEY)
    } catch {
      // A policy-denied read falls back to defaults for this page.
    }
    this.current = parsePreferences(raw)
  }

  readonly get = (): ClientPreferences => this.current

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setSeat(seat: ComposerSeat): void {
    this.patch({ seat })
  }

  setFamily(family: ProviderFamily): void {
    this.patch({ family })
  }

  setRegion(region: Region): void {
    this.patch({ region })
  }

  private patch(next: Partial<ClientPreferences>): void {
    const merged: ClientPreferences = { ...this.current, ...next }
    if (merged.seat === this.current.seat && merged.family === this.current.family && merged.region === this.current.region) {
      return
    }
    this.current = merged
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(merged))
    } catch {
      // A denied write only loses the preference after reload.
    }
    for (const listener of this.listeners) listener()
  }
}

/** One browser-wide store: every registration reads the same instance. */
export const clientPreferences = new ClientPreferencesStore()

/** Storage key, exported for tests that pre-seed a preference. */
export const CLIENT_PREFERENCES_STORAGE_KEY = STORAGE_KEY
