import { describe, expect, it } from 'vitest'
import { traeAccountId, type TraeCredential } from '../../../src/providers/trae/auth.ts'
import {
  credentialOfTransferRecord,
  knownRegionOfCredential,
  mergeTransferRecords,
  parseTransferFile,
  previewTransferFile,
  regionOfTransferRecord,
  traeTransferRecordOf,
  type TraeTransferRecord,
} from '../../../src/providers/trae/transfer.ts'
import { previewTransferOf, transferExportOf, transferIndexesOf } from '../../../src/providers/trae/transfer-hub.ts'

function siblingRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'at-1',
    refresh_token: 'rt-1',
    uid: 'u-1',
    nickname: '小明',
    email: 'a@b.c',
    domain: 'https://api.trae.cn',
    expiresAt: 1893456000000,
    ...overrides,
  }
}

function vaultCredential(overrides: Partial<TraeCredential> = {}): TraeCredential {
  return {
    accessToken: 'at-vault',
    refreshToken: 'rt-vault',
    userId: 'u-9',
    accountName: '阿九',
    host: 'https://api.trae.cn',
    expiresAtMs: 1893456000000,
    refreshExpiresAtMs: 1896048000000,
    edition: 'cn',
    source: 'dsh',
    ...overrides,
  }
}

describe('parseTransferFile', () => {
  it('accepts a JSON array of objects and rejects everything else with a positioned error', () => {
    expect(parseTransferFile(JSON.stringify([siblingRecord(), siblingRecord({ uid: 'u-2' })]))).toHaveLength(2)
    expect(() => parseTransferFile('')).toThrow('empty')
    expect(() => parseTransferFile('not json')).toThrow('JSON')
    expect(() => parseTransferFile('{"a":1}')).toThrow('array')
    expect(() => parseTransferFile('[{"uid":"u1"},42]')).toThrow('item 2')
  })
})

describe('transfer preview', () => {
  it('exposes only desensitized fields plus hasToken, normalizing dirty display values', () => {
    const dirty = JSON.stringify([
      { uid: { nested: true }, nickname: { zh: '信封昵称' }, email: ['a@b.c'], access_token: 'tok' },
      { uid: 'u-2', nickname: 12345, email: 'x@y.z' },
    ])
    const preview = previewTransferFile(dirty)
    expect(preview.total).toBe(2)
    expect(preview.accounts[0]?.hasToken).toBe(true)
    expect(preview.accounts[0]?.uid).toBe('')
    expect(preview.accounts[0]?.nickname).toBe('')
    expect(preview.accounts[1]?.hasToken).toBe(false)
    expect(preview.accounts[1]?.nickname).toBe('12345')
  })

  it('masks email/phone labels so identifiers do not cross into the preview', () => {
    const preview = previewTransferOf(JSON.stringify([
      { access_token: 'x', email: 'alice@example.com', domain: 'https://api.trae.cn' },
      { access_token: 'y', nickname: '13800138000', domain: 'https://api.trae.cn' },
      { access_token: 'z', nickname: '小明', domain: 'https://api.trae.cn' },
    ]))
    expect(preview.rows.map(row => row.label)).toEqual(['a***e@example.com', '***8000', '小明'])
  })

  it('never lets token material reach the serialized preview', () => {
    const preview = previewTransferFile(JSON.stringify([
      siblingRecord({ access_token: 'SECRET_TOK_123', refresh_token: 'SECRET_REF_456' }),
    ]))
    const serialized = JSON.stringify(preview)
    expect(serialized).not.toContain('SECRET_TOK_123')
    expect(serialized).not.toContain('SECRET_REF_456')
    expect(preview.accounts[0]?.hasToken).toBe(true)
  })

  it('projects hub preview rows with a positively identified region only', () => {
    const preview = previewTransferOf(JSON.stringify([
      siblingRecord(),
      siblingRecord({ domain: 'https://coresg-normal.trae.ai', uid: 'u-2' }),
      siblingRecord({ domain: 'https://example.com', uid: 'u-3' }),
      siblingRecord({ access_token: '', uid: 'u-4' }),
    ]))
    expect(preview.rows.map(row => row.region)).toEqual(['cn', 'global', 'unknown', 'cn'])
    // `hasToken` reports token presence; the foreign-host row carries one but is
    // not importable, so the skipped count covers it and the token-less row.
    expect(preview.rows.map(row => row.hasToken)).toEqual([true, true, true, false])
    expect(preview.skipped).toBe(2)
    // Ids address records in the file, never credentials.
    expect(preview.rows.map(row => row.id)).toEqual(['account:0', 'account:1', 'account:2', 'account:3'])
    expect(JSON.stringify(preview)).not.toContain('at-1')
  })
})

describe('credentialOfTransferRecord', () => {
  it('passes the millisecond expiry through verbatim and restores the edition from the host', () => {
    const credential = credentialOfTransferRecord(siblingRecord() as never)
    expect(credential).toBeDefined()
    expect(credential?.expiresAtMs).toBe(1893456000000)
    expect(credential?.edition).toBe('cn')
    expect(credentialOfTransferRecord(siblingRecord({ domain: 'https://coresg-normal.trae.ai' }) as never)?.edition).toBe('sg')
    expect(credentialOfTransferRecord(siblingRecord({ access_token: '' }) as never)).toBeUndefined()
  })

  it('recovers identity from a nested auth_raw document', () => {
    const credential = credentialOfTransferRecord({
      access_token: 'at',
      domain: 'https://api.trae.cn',
      auth_raw: {
        auth: { userRegion: { region: 'CN' } },
        account: { username: '阿九', userId: 'u-9' },
      },
    } as never)
    expect(credential?.accountName).toBe('阿九')
    expect(credential?.userId).toBe('u-9')
    expect(credential?.userRegion).toBe('CN')
  })
})

describe('region gate', () => {
  it('accepts a record only when its own claim positively matches the target region', () => {
    const records = [
      siblingRecord(),
      siblingRecord({ domain: 'https://coresg-normal.trae.ai', uid: 'u-ai' }),
      siblingRecord({ domain: 'https://example.com', uid: 'u-forged' }),
      siblingRecord({ domain: '', uid: 'u-empty' }),
    ] as unknown as TraeTransferRecord[]
    const indexes = [0, 1, 2, 3]
    const cn = mergeTransferRecords(records, indexes, 'cn')
    expect(cn.imported).toBe(1)
    expect(cn.skipped).toBe(3)
    const ai = mergeTransferRecords(records, indexes, 'ai')
    expect(ai.imported).toBe(1)
    expect(ai.skipped).toBe(3)
  })

  it('knownRegionOfCredential never defaults an unrecognized claim and requires HTTPS', () => {
    expect(knownRegionOfCredential({ host: 'https://api.trae.cn' })).toBe('cn')
    expect(knownRegionOfCredential({ host: 'https://coresg-normal.trae.ai' })).toBe('ai')
    expect(knownRegionOfCredential({ host: 'https://www.trae.com.cn' })).toBe('cn')
    expect(knownRegionOfCredential({ host: 'https://evil.example' })).toBeUndefined()
    expect(knownRegionOfCredential({ host: 'http://api.trae.cn' })).toBeUndefined()
    expect(knownRegionOfCredential({ host: 'https://api.trae.cn:8443' })).toBeUndefined()
    expect(knownRegionOfCredential({})).toBeUndefined()
    // A known host and a contradicting claim are inconsistent, not "host wins".
    expect(knownRegionOfCredential({ host: 'https://api.trae.cn', userRegion: 'SG' })).toBeUndefined()
    expect(knownRegionOfCredential({ host: 'https://api.trae.cn', userRegion: 'CN' })).toBe('cn')
    // An unrecognized claim falls back to the host suffix; only an unrecognizable pair is undefined.
    expect(knownRegionOfCredential({ userRegion: 'EU', host: 'https://api.trae.cn' })).toBe('cn')
    expect(knownRegionOfCredential({ userRegion: 'EU', host: 'https://evil.example' })).toBeUndefined()
  })

  it('rejects a record whose file-authored host is not a known HTTPS Trae gateway', () => {
    expect(credentialOfTransferRecord(siblingRecord({ domain: 'https://evil.example' }) as never)).toBeUndefined()
    expect(credentialOfTransferRecord(siblingRecord({ domain: 'http://api.trae.cn' }) as never)).toBeUndefined()
    expect(credentialOfTransferRecord(siblingRecord({ domain: 'https://api.trae.cn.attacker.example' }) as never)).toBeUndefined()
    const merged = mergeTransferRecords(
      [siblingRecord({ domain: 'https://evil.example' })] as unknown as TraeTransferRecord[],
      [0],
      'cn',
    )
    expect(merged.imported).toBe(0)
    expect(merged.skipped).toBe(1)
  })

  it('rejects a record whose host and region claim disagree', () => {
    const inconsistent = siblingRecord({
      domain: 'https://coresg-normal.trae.ai',
      auth_raw: { userRegion: { region: 'CN' } },
    }) as unknown as TraeTransferRecord
    expect(credentialOfTransferRecord(inconsistent)).toBeUndefined()
    expect(regionOfTransferRecord(inconsistent)).toBeUndefined()
    expect(mergeTransferRecords([inconsistent], [0], 'cn').imported).toBe(0)
    expect(mergeTransferRecords([inconsistent], [0], 'ai').imported).toBe(0)
  })

  it('rejects a forged region claim on a foreign host', () => {
    const forged: TraeTransferRecord = {
      access_token: 'attacker-access-token',
      refresh_token: 'attacker-refresh-token',
      uid: 'attacker',
      domain: 'http://evil.example',
      auth_raw: { userRegion: { region: 'CN' } },
    }
    expect(mergeTransferRecords([forged], [0], 'cn')).toMatchObject({ imported: 0, skipped: 1 })
    expect(credentialOfTransferRecord(forged)).toBeUndefined()
  })

  it('binds a host-less legacy record to the target region canonical gateway', () => {
    const legacy = {
      access_token: 'legacy-token',
      refresh_token: 'legacy-refresh',
      uid: 'legacy-user',
      auth_raw: { userRegion: { region: 'CN' } },
    } as unknown as TraeTransferRecord
    const result = mergeTransferRecords([legacy], [0], 'cn')
    expect(result.imported).toBe(1)
    expect([...result.changes.values()][0]).toMatchObject({
      host: 'https://api.trae.cn',
      edition: 'cn',
    })
    const international = mergeTransferRecords(
      [{ ...legacy, auth_raw: { userRegion: { region: 'SG' } } } as unknown as TraeTransferRecord],
      [0],
      'ai',
    )
    expect(international.imported).toBe(1)
    expect([...international.changes.values()][0]).toMatchObject({
      host: 'https://growsg-normal.trae.ai',
      edition: 'sg',
    })
  })
})

describe('export / import interop', () => {
  it('exports records a sibling tool can read back into the same account', () => {
    const credential = vaultCredential()
    const exported = transferExportOf('cn', [credential])
    expect(exported.fileName).toBe('trae-cn-accounts.json')
    const parsed = parseTransferFile(exported.content)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.['access_token']).toBe('at-vault')
    const restored = credentialOfTransferRecord(parsed[0]!)
    expect(restored).toBeDefined()
    expect(traeAccountId(restored!)).toBe(traeAccountId(credential))
    expect(restored?.expiresAtMs).toBe(credential.expiresAtMs)
    // The explicit export action is the only place the token leaves the host.
    expect(exported.content).toContain('at-vault')
    expect((parseTransferFile(exported.content)[0]?.['auth_raw'] as { auth?: { accessToken?: string } })?.auth?.accessToken)
      .toBe('at-vault')
  })

  it('maps preview ids back to record indexes and ignores unknown ids', () => {
    expect(transferIndexesOf(['account:0', 'account:2', 'nope', 'account:9', 'account:x'], 3)).toEqual([0, 2])
    expect(transferIndexesOf([], 3)).toEqual([])
  })

  it('records exported by another tool import into their own region only', () => {
    const aiCredential = vaultCredential({
      host: 'https://coresg-normal.trae.ai',
      userRegion: 'SG',
      edition: 'sg',
      accessToken: 'at-ai',
    })
    const record = traeTransferRecordOf(aiCredential, { auth: { userRegion: 'SG' } })
    expect(mergeTransferRecords([record], [0], 'cn').imported).toBe(0)
    expect(mergeTransferRecords([record], [0], 'ai').imported).toBe(1)
  })
})
