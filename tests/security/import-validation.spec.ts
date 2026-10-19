/**
 * Adversarial import/migration tests.
 *
 * Trae's account transfer file is externally supplied: importing it must never
 * move a credential into the wrong region, and must never let the file pick an
 * arbitrary network host. These tests were converted to enforcing assertions
 * when refresh-host validation landed.
 */
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  credentialOfTransferRecord,
  knownRegionOfCredential,
  mergeTransferRecords,
  parseTransferFile,
  previewTransferFile,
  traeTransferRecordOf,
  type TraeTransferRecord,
} from '../../src/providers/trae/transfer.ts'
import { previewTransferOf, transferExportOf, transferIndexesOf } from '../../src/providers/trae/transfer-hub.ts'
import { canonicalRefreshHost, normalizeTraeGatewayHost, refreshHostOf } from '../../src/providers/trae/hosts.ts'
import type { TraeCredential } from '../../src/providers/trae/auth.ts'

function credential(overrides: Partial<TraeCredential> = {}): TraeCredential {
  return {
    accessToken: 'cn-access-token-value',
    refreshToken: 'cn-refresh-token-value',
    userId: 'user-1',
    accountName: 'Alice',
    host: 'https://www.trae.cn',
    expiresAtMs: 1_800_000_000_000,
    edition: 'cn',
    source: 'desktop',
    ...overrides,
  }
}

let cleanup: string | undefined
afterEach(async () => {
  if (cleanup !== undefined) {
    await rm(cleanup, { recursive: true, force: true })
    cleanup = undefined
  }
})

describe('Trae transfer: region gate', () => {
  const otherRegion: TraeTransferRecord = {
    access_token: 'ai-token',
    domain: 'https://www.trae.ai',
  }
  const cnRecord: TraeTransferRecord = {
    access_token: 'cn-token',
    refresh_token: 'cn-refresh',
    uid: 'user-1',
    nickname: 'Alice',
    domain: 'https://www.trae.cn',
    expiresAt: 1_800_000_000_000,
  }

  it('imports a positively identified CN record into CN only', () => {
    const result = mergeTransferRecords([cnRecord], [0], 'cn')
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(0)
    expect([...result.changes.values()][0]).toMatchObject({
      accessToken: 'cn-token',
      host: 'https://www.trae.cn',
      edition: 'cn',
    })
  })

  it('skips records whose own claim is another region', () => {
    const result = mergeTransferRecords([otherRegion], [0], 'cn')
    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(1)
    const ai = mergeTransferRecords([cnRecord], [0], 'ai')
    expect(ai.imported).toBe(0)
  })

  it('skips records with no token and indexes the file by position only', () => {
    const noToken = { domain: 'https://www.trae.cn' } as unknown as TraeTransferRecord
    const result = mergeTransferRecords([noToken, cnRecord], [0, 1, 99, -1], 'cn')
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(3)
  })

  it('rejects malformed transfer files', () => {
    expect(() => parseTransferFile('')).toThrow(/empty/)
    expect(() => parseTransferFile('{}')).toThrow(/array/)
    expect(() => parseTransferFile('[1]')).toThrow(/not an account object/)
    expect(() => parseTransferFile('not json')).toThrow(/valid JSON/)
  })

  it('does not let an auth_raw object pollute Object.prototype', () => {
    const parsed = parseTransferFile(JSON.stringify([{
      access_token: 'token',
      domain: 'https://www.trae.cn',
      auth_raw: JSON.parse('{"__proto__":{"polluted":true},"userRegion":{"region":"CN"}}'),
    }]))
    const result = mergeTransferRecords(parsed, [0], 'cn')
    expect(result.imported).toBe(1)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })

  it('rejects a foreign/plaintext refresh host even when auth_raw claims CN', () => {
    const forged: TraeTransferRecord = {
      access_token: 'attacker-access-token',
      refresh_token: 'attacker-refresh-token',
      uid: 'attacker',
      domain: 'http://evil.example',
      auth_raw: { userRegion: { region: 'CN' } },
    }
    const result = mergeTransferRecords([forged], [0], 'cn')
    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(1)
    expect(credentialOfTransferRecord(forged)).toBeUndefined()
    // https alone is not enough: the hostname must be a known Trae gateway.
    expect(credentialOfTransferRecord({ access_token: 't', domain: 'https://evil.example' })).toBeUndefined()
    // Plaintext is refused too, even for a genuine Trae hostname.
    expect(credentialOfTransferRecord({ access_token: 't', domain: 'http://www.trae.cn' })).toBeUndefined()
    // Embedded credentials and non-standard ports are refused (origin only).
    expect(credentialOfTransferRecord({ access_token: 't', domain: 'https://user:pw@www.trae.cn' })).toBeUndefined()
    expect(credentialOfTransferRecord({ access_token: 't', domain: 'https://www.trae.cn:8443' })).toBeUndefined()
  })

  it('normalizes a known HTTPS gateway to its origin and keeps the region', () => {
    const stored = credentialOfTransferRecord({
      access_token: 't',
      domain: 'https://www.trae.cn/some/path?x=1',
      auth_raw: { userRegion: { region: 'CN' } },
    })
    expect(stored?.host).toBe('https://www.trae.cn')
    expect(stored?.edition).toBe('cn')
    expect(knownRegionOfCredential({ host: 'https://www.trae.cn', userRegion: 'CN' })).toBe('cn')
    expect(knownRegionOfCredential({ host: 'https://www.trae.ai' })).toBe('ai')
    expect(normalizeTraeGatewayHost('https://api.trae.cn')?.host).toBe('https://api.trae.cn')
  })

  it('the host and the region claim must agree', () => {
    expect(credentialOfTransferRecord({
      access_token: 't',
      domain: 'https://www.trae.ai',
      auth_raw: { userRegion: { region: 'CN' } },
    })).toBeUndefined()
    expect(knownRegionOfCredential({ host: 'https://www.trae.ai', userRegion: 'CN' })).toBeUndefined()
    expect(knownRegionOfCredential({ host: 'http://www.trae.cn', userRegion: 'CN' })).toBeUndefined()
  })

  it('host-less legacy records are bound to the canonical region gateway', () => {
    const cn = mergeTransferRecords([{ access_token: 't', auth_raw: { userRegion: { region: 'CN' } } }], [0], 'cn')
    expect(cn.imported).toBe(1)
    expect([...cn.changes.values()][0]?.host).toBe(canonicalRefreshHost('cn'))
    const ai = mergeTransferRecords([{ access_token: 't', auth_raw: { userRegion: { region: 'SG' } } }], [0], 'ai')
    expect(ai.imported).toBe(1)
    expect([...ai.changes.values()][0]?.host).toBe(canonicalRefreshHost('ai'))
  })

  it('refresh refuses a non-gateway or region-mismatched host before any network call', () => {
    expect(() => refreshHostOf({ host: 'http://evil.example', edition: 'cn', userRegion: 'CN' })).toThrow()
    expect(() => refreshHostOf({ host: 'https://evil.example', edition: 'cn' })).toThrow()
    expect(() => refreshHostOf({ host: 'https://www.trae.ai', edition: 'cn', userRegion: 'CN' })).toThrow()
    expect(refreshHostOf({ host: 'https://www.trae.cn', edition: 'cn', userRegion: 'CN' })).toBe('https://www.trae.cn')
    // Legacy/CLI credentials with no host fall back to a verified constant.
    expect(refreshHostOf({ host: '', edition: 'cn' })).toBe(canonicalRefreshHost('cn'))
    expect(refreshHostOf({ host: '', edition: 'sg' })).toBe(canonicalRefreshHost('ai'))
  })
})

describe('Trae transfer: preview and export boundary', () => {
  it('masks personal identifiers in the preview', () => {
    const text = JSON.stringify([
      { access_token: 'tok-1', uid: 'user-1234', nickname: 'alice@example.com', email: 'alice@example.com', domain: 'https://www.trae.cn' },
      { access_token: 'tok-2', nickname: '+8613800138000', domain: 'https://www.trae.ai' },
      { access_token: 'tok-3', nickname: 'Bob', domain: 'https://evil.example' },
    ])
    const preview = previewTransferOf(text)
    const serialized = JSON.stringify(preview)
    expect(serialized).not.toContain('alice@example.com')
    expect(serialized).not.toContain('13800138000')
    expect(serialized).not.toContain('tok-1')
    expect(preview.rows[2]?.region).toBe('unknown')
    expect(preview.rows[0]?.hasToken).toBe(true)
    // `hasToken` describes token presence; the importer's `skipped` count is
    // where the invalid foreign host is reported.
    expect(preview.rows[2]?.hasToken).toBe(true)
    expect(preview.skipped).toBe(1)
  })

  it('previews an export file without exposing its tokens', () => {
    const exported = transferExportOf('cn', [credential()])
    // The export action itself deliberately carries credentials (documented).
    expect(exported.content).toContain('cn-access-token-value')
    const preview = previewTransferOf(exported.content)
    expect(JSON.stringify(preview)).not.toContain('cn-access-token-value')
    expect(JSON.stringify(preview)).not.toContain('cn-refresh-token-value')
    expect(preview.rows[0]?.hasToken).toBe(true)
  })

  it('maps only in-range preview ids back to records', () => {
    expect(transferIndexesOf(['account:0', 'account:1', 'account:1', 'account:99', 'account:-1', 'junk', 'account:x'], 2))
      .toEqual([0, 1])
  })

  it('carries tokens only through the explicit export record shape', () => {
    const record = traeTransferRecordOf(credential(), { auth: { accessToken: 'cn-access-token-value' } })
    expect(record.access_token).toBe('cn-access-token-value')
    expect(record.refresh_token).toBe('cn-refresh-token-value')
    expect(previewTransferFile(JSON.stringify([record])).accounts[0]?.hasToken).toBe(true)
  })
})
