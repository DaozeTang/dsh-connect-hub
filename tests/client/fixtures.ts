/**
 * HubStatus fixture builders shared by the client render tests. Pure data
 * only: no network, no client imports, no JSX.
 */

import type {
  AccountView,
  BilingualText,
  CheckinLogRow,
  CheckinView,
  CreditsPackage,
  CreditsView,
  HubModel,
  HubStatus,
  ProbeView,
  ProviderCredentialView,
  ProviderFamily,
  ProviderId,
  ProviderStatus,
  Region,
  WarningView,
} from '../../src/shared/contracts.ts'

/** A fixed clock so relative labels and expiry logic are deterministic. */
export const NOW = Date.UTC(2026, 9, 18, 3, 0, 0)
export const HOUR = 3_600_000
export const DAY = 86_400_000

const LABELS: Record<ProviderId, BilingualText> = {
  qoder: { zh: 'Qoder', en: 'Qoder' },
  'qoder-global': { zh: 'Qoder Global', en: 'Qoder Global' },
  workbuddy: { zh: 'WorkBuddy', en: 'WorkBuddy' },
  'workbuddy-ai': { zh: 'WorkBuddy AI', en: 'WorkBuddy AI' },
  trae: { zh: 'Trae', en: 'Trae' },
  'trae-global': { zh: 'Trae Global', en: 'Trae Global' },
}

const FAMILY_OF: Record<ProviderId, ProviderFamily> = {
  qoder: 'qoder',
  'qoder-global': 'qoder',
  workbuddy: 'workbuddy',
  'workbuddy-ai': 'workbuddy',
  trae: 'trae',
  'trae-global': 'trae',
}

const REGION_OF: Record<ProviderId, Region> = {
  qoder: 'cn',
  'qoder-global': 'global',
  workbuddy: 'cn',
  'workbuddy-ai': 'global',
  trae: 'cn',
  'trae-global': 'global',
}

/** One catalog model with sane defaults. */
export function buildModel(overrides: Partial<HubModel> = {}): HubModel {
  return {
    id: 'qwen3-coder',
    name: 'Qwen3 Coder',
    enabled: true,
    badges: ['推荐'],
    contextWindow: 131_072,
    maxContextWindow: 262_144,
    useMaxContext: false,
    inputs: ['text'],
    reasoning: null,
    ...overrides,
  }
}

export function buildCredits(overrides: Partial<CreditsView> = {}): CreditsView {
  return {
    kind: 'credits',
    remaining: 1_240,
    total: 2_000,
    updatedAt: NOW - 5 * 60_000,
    packages: [],
    ...overrides,
  }
}

/** Credits with a plan but no numeric amount (the plan fallback path). */
export function buildPlanCredits(plan: string): CreditsView {
  return { kind: 'subscription', plan, packages: [] }
}

export function buildPackage(overrides: Partial<CreditsPackage> = {}): CreditsPackage {
  return {
    id: 'pkg-1',
    name: '新手额度包',
    remaining: 240,
    total: 1_000,
    expiresAt: NOW + 3 * DAY,
    ...overrides,
  }
}

export function buildLogRow(overrides: Partial<CheckinLogRow> = {}): CheckinLogRow {
  return { at: NOW - DAY, ok: true, message: '签到成功，获得 100 Credits', ...overrides }
}

export function buildCheckin(overrides: Partial<CheckinView> = {}): CheckinView {
  return {
    supported: true,
    enabled: true,
    minute: 600,
    lastRunAt: NOW - 6 * HOUR,
    state: 'claimed',
    reward: 100,
    log: [buildLogRow()],
    ...overrides,
  }
}

export function buildAccount(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: 'acct-1',
    label: 'alice@example.com',
    detail: '个人账号',
    selected: true,
    state: 'ok',
    expiresAt: NOW + 7 * DAY,
    refreshExpiresAt: NOW + 30 * DAY,
    credits: buildCredits({ remaining: 800, total: 2_000 }),
    checkin: buildCheckin(),
    ...overrides,
  }
}

export function buildProbe(overrides: Partial<ProbeView> = {}): ProbeView {
  return {
    modelId: 'qwen3-coder',
    modelName: 'Qwen3 Coder',
    state: 'ok',
    efforts: ['low', 'medium', 'high'],
    at: NOW - HOUR,
    ...overrides,
  }
}

export function buildWarning(overrides: Partial<WarningView> = {}): WarningView {
  return { code: 'warn-1', level: 'warn', message: 'PAT 无效或已过期', at: NOW - HOUR, ...overrides }
}

export function buildCredential(overrides: Partial<ProviderCredentialView> = {}): ProviderCredentialView {
  return {
    source: 'plugin',
    masked: '****abcd',
    savedAt: NOW - DAY,
    writable: true,
    ...overrides,
  }
}

const DEFAULT_CAPABILITIES: ProviderStatus['capabilities'] = {
  usage: false,
  checkin: false,
  transfer: false,
  probes: false,
  multiAccount: false,
}

/** One provider status route with family/region/label derived from its id. */
export function buildProvider(id: ProviderId, overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    id,
    family: FAMILY_OF[id],
    region: REGION_OF[id],
    label: LABELS[id],
    state: 'needs-credential',
    catalog: { source: 'builtin', models: [] },
    warnings: [],
    capabilities: { ...DEFAULT_CAPABILITIES },
    ...overrides,
  }
}

/** One hub snapshot with a stable key; the revision increments per call site. */
export function buildHubStatus(providers: ProviderStatus[], overrides: Partial<HubStatus> = {}): HubStatus {
  return {
    version: '0.1.0',
    revision: 1,
    now: NOW,
    key: 'test-hub-key',
    warnings: [],
    providers,
    ...overrides,
  }
}

const QODER_MODELS: HubModel[] = [
  buildModel({ id: 'qwen3-coder', name: 'Qwen3 Coder', badges: ['推荐'], multiplier: 0.5, inputs: ['text', 'image'] }),
  buildModel({
    id: 'qwen3-max',
    name: 'Qwen3 Max',
    enabled: false,
    badges: [],
    contextWindow: 262_144,
    maxContextWindow: 1_000_000,
    reasoning: { supported: ['low', 'medium', 'high'], canDisable: true },
  }),
  buildModel({ id: 'qwen2.5-vl', name: 'Qwen2.5 VL', badges: ['免费'], multiplier: 0, inputs: ['text', 'image'] }),
]

/** A Qoder CN provider that is fully usable. */
export function buildQoderReady(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return buildProvider('qoder', {
    state: 'ready',
    credential: buildCredential(),
    account: { label: 'alice@example.com', detail: '个人版' },
    credits: buildCredits({ packages: [buildPackage()] }),
    checkin: buildCheckin(),
    catalog: { source: 'live', updatedAt: NOW - 2 * 60_000, models: QODER_MODELS },
    warnings: [buildWarning({ code: 'quota-low', level: 'warn', message: '额度即将用尽' })],
    capabilities: { usage: true, checkin: true, transfer: false, probes: false, multiAccount: false },
    ...overrides,
  })
}

/** A Qoder CN provider signed in through the desktop app's imported login. */
export function buildQoderAppLogin(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return buildProvider('qoder', {
    state: 'ready',
    credential: {
      source: 'app',
      writable: false,
      masked: '****9f2c',
      expiresAt: NOW + 6 * HOUR,
      refreshExpiresAt: NOW + 20 * DAY,
    },
    account: { label: 'Qoder 用户', detail: 'q***@example.com' },
    catalog: { source: 'live', updatedAt: NOW - 2 * 60_000, models: QODER_MODELS },
    capabilities: { usage: true, checkin: true, transfer: false, probes: false, multiAccount: false },
    ...overrides,
  })
}

/** A WorkBuddy CN provider with credits and probes but no check-in. */
export function buildWorkBuddyReady(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return buildProvider('workbuddy', {
    state: 'ready',
    credential: buildCredential({ source: 'app', expiresAt: NOW + 3 * DAY, refreshExpiresAt: NOW + 40 * DAY }),
    account: { label: 'WorkBuddy 用户', detail: '桌面端登录' },
    credits: buildCredits({ kind: 'subscription', remaining: 320, total: 500, plan: 'Pro' }),
    catalog: { source: 'saved', updatedAt: NOW - HOUR, models: [buildModel({ id: 'wb-pro', name: 'WorkBuddy Pro', multiplier: 2 })] },
    probes: { supported: true, consent: true, rows: [buildProbe({ modelId: 'wb-pro', modelName: 'WorkBuddy Pro' })] },
    capabilities: { usage: true, checkin: false, transfer: false, probes: true, multiAccount: false },
    ...overrides,
  })
}

/** A Trae CN provider with two accounts, check-in and transfer. */
export function buildTraeReady(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  const accounts = [
    buildAccount({ id: 'trae-a', label: 'alice@example.com', selected: true }),
    buildAccount({ id: 'trae-b', label: 'bob@example.com', selected: false, state: 'expired', expiresAt: NOW - HOUR }),
  ]
  return buildProvider('trae', {
    state: 'ready',
    credential: buildCredential({ source: 'plugin', writable: false }),
    accounts,
    catalog: { source: 'live', updatedAt: NOW - 30_000, models: [buildModel({ id: 'trae-solo', name: 'Trae Solo', multiplier: 1 })] },
    checkin: buildCheckin(),
    probes: { supported: true, consent: false, rows: [buildProbe({ modelId: 'trae-solo', modelName: 'Trae Solo', state: 'unknown', efforts: [] })] },
    transfer: { supported: true },
    capabilities: { usage: true, checkin: true, transfer: true, probes: true, multiAccount: true },
    ...overrides,
  })
}

/** All six routes, three ready, so family switching has data everywhere. */
export function buildAllProviders(): ProviderStatus[] {
  return [
    buildQoderReady(),
    buildProvider('qoder-global', {
      state: 'needs-credential',
      catalog: { source: 'builtin', models: [] },
      capabilities: { usage: true, checkin: true, transfer: false, probes: false, multiAccount: false },
    }),
    buildWorkBuddyReady(),
    buildProvider('workbuddy-ai', {
      state: 'signed-out',
      capabilities: { usage: true, checkin: false, transfer: false, probes: true, multiAccount: false },
    }),
    buildTraeReady(),
    buildProvider('trae-global', { state: 'needs-credential', capabilities: { usage: true, checkin: true, transfer: true, probes: true, multiAccount: true } }),
  ]
}
