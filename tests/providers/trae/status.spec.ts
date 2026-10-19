import { describe, expect, it } from 'vitest'
import type { TraeCredential } from '../../../src/providers/trae/auth.ts'
import { defaultTraePrefs } from '../../../src/providers/trae/prefs.ts'
import type { TraeRuntimeSnapshot } from '../../../src/providers/trae/state.ts'
import { buildTraeStatus } from '../../../src/providers/trae/status.ts'
import { checkinSnapshotOf } from '../../../src/providers/trae/usage-view.ts'

const FULL_TOKEN = 'super-secret-access-token-abcdefgh'

const credential: TraeCredential = {
  accessToken: FULL_TOKEN,
  refreshToken: 'refresh-secret',
  userId: 'u1',
  accountName: '小明',
  host: 'https://api.trae.cn',
  userRegion: 'CN',
  expiresAtMs: Date.now() + 3_600_000,
  refreshExpiresAtMs: Date.now() + 86_400_000,
  edition: 'cn',
  source: 'desktop',
}

function snapshot(overrides: Partial<TraeRuntimeSnapshot> = {}): TraeRuntimeSnapshot {
  return {
    accounts: [{
      id: 'acc-1',
      accountName: '小明',
      edition: 'cn',
      region: 'cn',
      source: 'desktop',
      tokenExpiresAtMs: credential.expiresAtMs,
      refreshExpiresAtMs: credential.refreshExpiresAtMs!,
      selected: true,
    }],
    current: credential,
    catalog: [
      {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        contextWindow: 200_000,
        maxContextWindow: 1_000_000,
        creditMultiplier: 0.08,
        input: ['text'],
        multimodal: true,
        reasoningSupported: true,
        reasoning: { supported: ['low', 'high'], defaultEffort: 'high' },
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        contextWindow: 200_000,
        input: ['text'],
        reasoningSupported: false,
      },
    ],
    catalogSource: 'live',
    catalogUpdatedAt: 123,
    checkinByAccount: {
      'acc-1': checkinSnapshotOf({ checkedIn: false, didCheckedIn: true, credits: 20, enabled: true }),
    },
    ...overrides,
  }
}

function withoutCurrent(base: TraeRuntimeSnapshot): TraeRuntimeSnapshot {
  const next: TraeRuntimeSnapshot = { ...base }
  delete next.current
  return next
}

describe('Trae provider status', () => {
  it('reports a ready CN provider with masked credentials and the full catalog', () => {
    const status = buildTraeStatus({
      providerId: 'trae',
      region: 'cn',
      label: { zh: 'Trae', en: 'Trae' },
      snapshot: snapshot(),
      prefs: defaultTraePrefs(),
    })
    expect(status.state).toBe('ready')
    expect(status.region).toBe('cn')
    expect(status.credential).toMatchObject({ source: 'app', masked: '****efgh', writable: false })
    expect(status.account).toMatchObject({ label: '小明' })
    expect(status.accounts).toHaveLength(1)
    expect(status.accounts?.[0]).toMatchObject({ id: 'acc-1', selected: true, state: 'ok' })
    expect(status.catalog.source).toBe('live')
    expect(status.catalog.models.map(model => model.id)).toEqual(['glm-5.2', 'deepseek-v4-pro'])
    expect(status.catalog.models[0]).toMatchObject({
      id: 'glm-5.2',
      enabled: true,
      multiplier: 0.08,
      contextWindow: 200_000,
      maxContextWindow: 1_000_000,
      useMaxContext: false,
      inputs: ['text', 'image'],
      badges: [],
      reasoning: { supported: ['low', 'high'], default: 'high', canDisable: false },
    })
    expect(status.catalog.models[1]).toMatchObject({
      enabled: true,
      contextWindow: 200_000,
      maxContextWindow: 200_000,
      useMaxContext: false,
      inputs: ['text'],
      reasoning: null,
    })
    expect(status.checkin).toMatchObject({ supported: true, state: 'device-used', enabled: true })
    expect(status.capabilities).toEqual({
      usage: true,
      checkin: true,
      transfer: true,
      probes: true,
      multiAccount: true,
    })
  })

  it('never exposes token material anywhere in the status document', () => {
    const status = buildTraeStatus({
      providerId: 'trae',
      region: 'cn',
      label: { zh: 'Trae', en: 'Trae' },
      snapshot: snapshot({ hardError: 'Trae 令牌刷新失败，请重新登录' }),
      prefs: defaultTraePrefs(),
    })
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain(FULL_TOKEN)
    expect(serialized).not.toContain('refresh-secret')
    expect(serialized).toContain('****efgh')
    expect(status.state).toBe('error')
  })

  it('marks a transfer-imported credential as imported', () => {
    const status = buildTraeStatus({
      providerId: 'trae',
      region: 'cn',
      label: { zh: 'Trae', en: 'Trae' },
      snapshot: { ...snapshot(), current: { ...credential, source: 'dsh', imported: true } },
      prefs: defaultTraePrefs(),
    })
    expect(status.credential).toMatchObject({ source: 'plugin', imported: true })
  })

  it('reports needs-credential without a saved account and explains it', () => {
    const status = buildTraeStatus({
      providerId: 'trae-global',
      region: 'ai',
      label: { zh: 'Trae 国际版', en: 'Trae Global' },
      snapshot: withoutCurrent(snapshot({ accounts: [], checkinByAccount: {} })),
      prefs: defaultTraePrefs(),
    })
    expect(status.state).toBe('needs-credential')
    expect(status.region).toBe('global')
    expect(status.credential).toBeUndefined()
    expect(status.checkin).toBeUndefined()
    expect(status.warnings.map(warning => warning.code)).toContain('no_account')
    expect(status.capabilities.checkin).toBe(false)
  })

  it('masks an email or phone account label host-side', () => {
    const emailAccount = { ...snapshot().accounts[0]!, accountName: 'alice@example.com' }
    const status = buildTraeStatus({
      providerId: 'trae',
      region: 'cn',
      label: { zh: 'Trae', en: 'Trae' },
      snapshot: snapshot({ accounts: [emailAccount] }),
      prefs: defaultTraePrefs(),
    })
    expect(status.accounts?.[0]?.label).toBe('a***e@example.com')
    expect(JSON.stringify(status)).not.toContain('alice@example.com')
  })

  it('keeps a ready provider when only the access token lapsed but refresh is still possible', () => {
    const status = buildTraeStatus({
      providerId: 'trae',
      region: 'cn',
      label: { zh: 'Trae', en: 'Trae' },
      snapshot: snapshot({
        current: { ...credential, expiresAtMs: Date.now() - 60_000, refreshExpiresAtMs: Date.now() + 86_400_000 },
        accounts: [{
          ...snapshot().accounts[0]!,
          tokenExpiresAtMs: Date.now() - 60_000,
          refreshExpiresAtMs: Date.now() + 86_400_000,
        }],
      }),
      prefs: defaultTraePrefs(),
    })
    expect(status.state).toBe('ready')
    expect(status.warnings.map(warning => warning.code)).not.toContain('credential_refresh_expired')
    expect(status.accounts?.[0]?.state).toBe('ok')
  })

  it('reports an unrenewable login honestly as an error', () => {
    const status = buildTraeStatus({
      providerId: 'trae',
      region: 'cn',
      label: { zh: 'Trae', en: 'Trae' },
      snapshot: snapshot({
        current: { ...credential, expiresAtMs: Date.now() - 60_000, refreshExpiresAtMs: Date.now() - 1_000 },
        accounts: [{
          ...snapshot().accounts[0]!,
          tokenExpiresAtMs: Date.now() - 60_000,
          refreshExpiresAtMs: Date.now() - 1_000,
        }],
      }),
      prefs: defaultTraePrefs(),
    })
    expect(status.state).toBe('error')
    expect(status.accounts?.[0]?.state).toBe('expired')
    const warning = status.warnings.find(entry => entry.code === 'credential_refresh_expired')
    expect(warning?.level).toBe('error')
    expect(warning?.message).toContain('重新登录')
  })

  it('reports the stale selection as an error rather than silently switching accounts', () => {
    const status = buildTraeStatus({
      providerId: 'trae',
      region: 'cn',
      label: { zh: 'Trae', en: 'Trae' },
      snapshot: withoutCurrent(snapshot({ accounts: [{ ...snapshot().accounts[0]!, selected: false }] })),
      prefs: defaultTraePrefs(),
    })
    expect(status.state).toBe('error')
    expect(status.warnings.map(warning => warning.code)).toContain('account_missing')
    // A stale selection serves no rows: they would belong to an unknown account.
    expect(status.catalog.models).toEqual([])
    expect(JSON.stringify(status)).not.toContain('api.trae.cn')
  })

  it('applies model visibility and max-context preferences', () => {
    const prefs = defaultTraePrefs()
    prefs.modelEnabled['deepseek-v4-pro'] = false
    prefs.useMaxContext = true
    const status = buildTraeStatus({
      providerId: 'trae',
      region: 'cn',
      label: { zh: 'Trae', en: 'Trae' },
      snapshot: snapshot(),
      prefs,
    })
    const [glm, deepseek] = status.catalog.models
    expect(glm).toMatchObject({ enabled: true, useMaxContext: true, contextWindow: 1_000_000, inputs: ['text', 'image'] })
    expect(deepseek).toMatchObject({ enabled: false, useMaxContext: false, contextWindow: 200_000, inputs: ['text'] })
  })

  it('carries probe consent and cached verdicts', () => {
    const prefs = defaultTraePrefs()
    prefs.probeConsent = true
    prefs.probes['glm-5.2'] = { modelId: 'glm-5.2', state: 'ok', efforts: ['low', 'high'], at: 99 }
    prefs.probes['deepseek-v4-pro'] = { modelId: 'deepseek-v4-pro', state: 'unknown', efforts: [], message: 'no answer within 30s', at: 100 }
    const status = buildTraeStatus({
      providerId: 'trae',
      region: 'cn',
      label: { zh: 'Trae', en: 'Trae' },
      snapshot: snapshot(),
      prefs,
    })
    expect(status.probes?.consent).toBe(true)
    expect(status.probes?.rows).toEqual([
      { modelId: 'glm-5.2', modelName: 'GLM-5.2', state: 'ok', efforts: ['low', 'high'], at: 99 },
      { modelId: 'deepseek-v4-pro', modelName: 'DeepSeek-V4-Pro', state: 'unknown', efforts: [], message: 'no answer within 30s', at: 100 },
    ])
  })

  it('surfaces catalog and usage failures as actionable warnings', () => {
    const status = buildTraeStatus({
      providerId: 'trae',
      region: 'cn',
      label: { zh: 'Trae', en: 'Trae' },
      snapshot: snapshot({ catalogError: '读取 Trae 模型目录失败：HTTP 502', creditsError: '读取额度失败：HTTP 401' }),
      prefs: defaultTraePrefs(),
    })
    const messages = status.warnings.map(warning => warning.message)
    expect(messages.some(message => message.includes('模型目录'))).toBe(true)
    expect(messages.some(message => message.includes('额度'))).toBe(true)
  })
})
