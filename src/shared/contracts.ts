export type ProviderFamily = 'qoder' | 'workbuddy' | 'trae'

export type ProviderId =
  | 'qoder'
  | 'qoder-global'
  | 'workbuddy'
  | 'workbuddy-ai'
  | 'trae'
  | 'trae-global'

export type Region = 'cn' | 'global'

export interface BilingualText {
  zh: string
  en: string
}

export interface ModelReasoning {
  supported: string[]
  default?: string
  canDisable: boolean
}

export interface HubModel {
  id: string
  name: string
  enabled: boolean
  multiplier?: number
  badges: string[]
  contextWindow: number
  maxContextWindow: number
  useMaxContext: boolean
  inputs: ('text' | 'image')[]
  reasoning: ModelReasoning | null
}

export interface CreditsPackage {
  id: string
  name?: string
  remaining: number
  total?: number
  expiresAt?: number
}

export interface CreditsView {
  kind: 'credits' | 'subscription' | 'enterprise'
  remaining?: number
  total?: number
  plan?: string
  resetAt?: number
  updatedAt?: number
  error?: string
  packages: CreditsPackage[]
}

export type CheckinState = 'available' | 'claimed' | 'device-used' | 'unknown' | 'error'

/** Locale-independent values a host message may interpolate. */
export type HostMessageParams = Readonly<Record<string, string | number>>

export interface CheckinLogRow {
  at: number
  ok: boolean
  message: string
  /** Stable message code the client localizes; absent on rows from older versions. */
  code?: string
  params?: HostMessageParams
}

export interface CheckinView {
  supported: boolean
  enabled: boolean
  minute: number
  lastRunAt?: number
  state: CheckinState
  reward?: number
  log: CheckinLogRow[]
}

export interface AccountView {
  id: string
  label: string
  detail?: string
  selected: boolean
  state: 'ok' | 'expired' | 'error'
  expiresAt?: number
  refreshExpiresAt?: number
  credits?: CreditsView
  checkin?: CheckinView
}

export interface ProbeView {
  modelId: string
  modelName: string
  state: 'unknown' | 'running' | 'ok' | 'error' | 'inconclusive'
  efforts: string[]
  message?: string
  at?: number
}

export interface PromptGuardView {
  enabled: boolean
  rewritten: number
}

export interface WarningView {
  code: string
  level: 'info' | 'warn' | 'error'
  message: string
  at?: number
  /** Optional values for the client's localized copy (e.g. `{ count }`). */
  params?: Readonly<Record<string, string | number>>
}

export interface ProviderCredentialView {
  source: 'plugin' | 'env' | 'app'
  savedAt?: number
  masked?: string
  expiresAt?: number
  refreshExpiresAt?: number
  writable: boolean
  /** True when this copy came from the account-transfer import, not a local app. */
  imported?: boolean
}

export interface ProviderStatus {
  id: ProviderId
  family: ProviderFamily
  region: Region
  label: BilingualText
  state: 'ready' | 'needs-credential' | 'signed-out' | 'error'
  credential?: ProviderCredentialView
  account?: { label: string; detail?: string; enterprise?: boolean }
  accounts?: AccountView[]
  credits?: CreditsView
  checkin?: CheckinView
  probes?: { supported: boolean; consent: boolean; rows: ProbeView[] }
  promptGuard?: PromptGuardView
  transfer?: { supported: boolean }
  catalog: {
    source: 'live' | 'saved' | 'builtin'
    updatedAt?: number
    error?: string
    models: HubModel[]
  }
  warnings: WarningView[]
  capabilities: {
    usage: boolean
    checkin: boolean
    transfer: boolean
    probes: boolean
    multiAccount: boolean
  }
}

export interface HubStatus {
  version: string
  revision: number
  now: number
  key: string
  warnings: WarningView[]
  providers: ProviderStatus[]
}

export type HubAction =
  | { type: 'refresh-status' }
  | { type: 'refresh-catalog'; provider: ProviderId }
  | { type: 'refresh-usage'; provider: ProviderId }
  | { type: 'refresh-account'; provider: ProviderId }
  | { type: 'save-secret'; provider: ProviderId; secret: string }
  | { type: 'clear-secret'; provider: ProviderId }
  | { type: 'import-desktop-login'; provider: ProviderId }
  | { type: 'checkin'; provider: ProviderId; accountId?: string }
  | { type: 'set-checkin'; provider: ProviderId; enabled?: boolean; minute?: number }
  | { type: 'clear-checkin-log'; provider: ProviderId }
  | { type: 'set-model-enabled'; provider: ProviderId; modelId: string; enabled: boolean }
  | { type: 'set-models-enabled'; provider: ProviderId; modelIds: string[]; enabled: boolean }
  | { type: 'set-max-context'; provider: ProviderId; useMax: boolean }
  | { type: 'select-account'; provider: ProviderId; accountId: string }
  | { type: 'set-probe-consent'; provider: ProviderId; consent: boolean }
  | { type: 'set-prompt-guard'; provider: ProviderId; enabled: boolean }
  | { type: 'probe-model'; provider: ProviderId; modelId: string }
  | { type: 'test-models'; provider: ProviderId; modelIds: string[] }
  | { type: 'transfer-preview'; provider: ProviderId; text: string }
  | { type: 'transfer-import'; provider: ProviderId; text: string; accountIds: string[] }
  | { type: 'transfer-export'; provider: ProviderId; accountIds: string[] }

export interface ActionSuccess {
  ok: true
  message?: string
  /** Stable message code the client localizes when it knows the code. */
  code?: string
  params?: HostMessageParams
  data?: unknown
  status: HubStatus
}

export interface ActionFailure {
  ok: false
  error: string
  detail?: string
}

export type ActionResult = ActionSuccess | ActionFailure

export interface TransferPreviewRow {
  id: string
  label: string
  region: 'cn' | 'global' | 'unknown'
  hasToken: boolean
}

export interface TransferPreview {
  rows: TransferPreviewRow[]
  skipped: number
}

export interface TransferExport {
  fileName: string
  content: string
}

/** Browser and host halves must agree on the hub's HTTP route. */
export const HUB_ROUTE_BASE = '/plugins/dsh-connect-hub'

export const FAMILIES: readonly {
  id: ProviderFamily
  label: BilingualText
  providers: readonly ProviderId[]
}[] = [
  {
    id: 'qoder',
    label: { zh: 'Qoder', en: 'Qoder' },
    providers: ['qoder', 'qoder-global'],
  },
  {
    id: 'workbuddy',
    label: { zh: 'WorkBuddy', en: 'WorkBuddy' },
    providers: ['workbuddy', 'workbuddy-ai'],
  },
  {
    id: 'trae',
    label: { zh: 'Trae', en: 'Trae' },
    providers: ['trae', 'trae-global'],
  },
]

/** Every provider id this plugin serves, in display order. */
export const PROVIDER_IDS: readonly ProviderId[] = FAMILIES.flatMap((family) => family.providers)
