/** React bindings over the client stores. */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ClientPreferences } from './prefs.ts'
import { clientPreferences } from './prefs.ts'
import type { ComposerSnapshot, HubStatusSnapshot } from './status-source.ts'
import { composerStatus, HubStatusSource, SETTINGS_POLL_MS } from './status-source.ts'

export interface HubStatusBinding {
  snapshot: HubStatusSnapshot
  source: HubStatusSource
}

/**
 * Mount a settings scoped status source: one read on mount, a visibility-aware
 * five-second poll while mounted, teardown on unmount.
 */
export function useHubStatusSource(pollMs: number = SETTINGS_POLL_MS): HubStatusBinding {
  const ref = useRef<HubStatusSource | null>(null)
  if (ref.current === null) ref.current = new HubStatusSource({ intervalMs: pollMs })
  const source = ref.current
  useEffect(() => {
    source.start()
    return () => { source.stop() }
  }, [source])
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  return { snapshot, source }
}

/** Current browser-local presentation preferences (seat, last family/region). */
export function useClientPreferences(): ClientPreferences {
  return useSyncExternalStore(clientPreferences.subscribe, clientPreferences.get)
}

/** Shared composer readout cache. No timer: freshness is checked on show. */
export function useComposerStatus(): ComposerSnapshot {
  return useSyncExternalStore(composerStatus.subscribe, composerStatus.getSnapshot)
}
