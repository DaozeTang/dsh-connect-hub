import type { CreditsView } from '../../shared/contracts.ts'
import type { TraeAccountChoice, TraeCredential } from './auth.ts'
import type { TraeModelInfo } from './catalog.ts'
import type { TraeCheckinSnapshot } from './usage-view.ts'

/** The served directory and how fresh it is. */
interface TraeCatalogSnapshot {
  catalog: readonly TraeModelInfo[]
  catalogSource: 'live' | 'saved' | 'builtin'
  catalogUpdatedAt?: number
  catalogError?: string
}

/** The last cached credit answer for the bound account. */
interface TraeCreditsSnapshot {
  credits?: CreditsView
  creditsUpdatedAt?: number
  creditsError?: string
}

/**
 * Everything `status()` is allowed to read: a plain synchronous snapshot that
 * background work refreshes, and that a status call must never await or fetch.
 */
export interface TraeRuntimeSnapshot extends TraeCatalogSnapshot, TraeCreditsSnapshot {
  accounts: TraeAccountChoice[]
  current?: TraeCredential
  /** Last check-in answer per account id (account ids are hashes). */
  checkinByAccount: Record<string, TraeCheckinSnapshot>
  /** Hard credential failure that prevents use even though an account exists. */
  hardError?: string
}
