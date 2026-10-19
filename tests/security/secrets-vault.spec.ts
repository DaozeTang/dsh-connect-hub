/**
 * Adversarial secret-handling tests: redaction patterns, masking, and the
 * vault fallback file's on-disk permissions/atomicity.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { maskTail, redactHome, redactText } from '../../src/core/redact.ts'
import { writeJsonFile, writeTextFile } from '../../src/core/atomic.ts'
import { Vault } from '../../src/core/vault.ts'
import type { HubPaths } from '../../src/core/paths.ts'
import type { HubLogger } from '../../src/core/log.ts'
import type { Context } from '@deepseek-ai/cordis'

function silentLog(): HubLogger {
  const log: HubLogger = { info: () => {}, warn: () => {}, error: () => {}, child: () => log }
  return log
}

function pathsFor(root: string): HubPaths {
  return { home: root, dataDir: join(root, 'hub'), stateDir: join(root, 'hub', 'state') }
}

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxx\n-----END RSA PRIVATE KEY-----'

let cleanup: string | undefined
afterEach(async () => {
  if (cleanup !== undefined) {
    await rm(cleanup, { recursive: true, force: true })
    cleanup = undefined
  }
})

describe('redaction', () => {
  it('removes JWT, bearer, private-key and key=value secrets', () => {
    const text = `failed: ${JWT} Authorization: Bearer abcdefghijklmnop ${PEM}\naccess_token=super-secret-value api_key: "another-secret"`
    const redacted = redactText(text)
    expect(redacted).not.toContain(JWT)
    expect(redacted).not.toContain('abcdefghijklmnop')
    expect(redacted).not.toContain('MIIEowIBAAKCAQEAxxxx')
    expect(redacted).not.toContain('super-secret-value')
    expect(redacted).not.toContain('another-secret')
    expect(redacted).toContain('[redacted token]')
    expect(redacted).toContain('[redacted key]')
  })

  it('redacts explicitly supplied secret strings', () => {
    expect(redactText('token is pat-1234567890', ['pat-1234567890'])).toBe('token is [redacted]')
  })

  it('redacts the home directory from log text', () => {
    expect(redactHome('/Users/alice/.dsh/profiles/desktop/file', '/Users/alice'))
      .toBe('~/.dsh/profiles/desktop/file')
  })

  it('masks only a short tail and never a short secret', () => {
    expect(maskTail('pat-1234567890')).toBe('****7890')
    expect(maskTail('abc')).toBe('****')
    expect(maskTail(undefined)).toBeUndefined()
    expect(maskTail('')).toBeUndefined()
  })

  it('DOCUMENTS GAP: opaque tokens with no marker are not caught by pattern redaction', () => {
    // Providers must never log raw credentials; the shared redactor only knows
    // the shapes below. A bare opaque token (no key=, no Bearer, no JWT) passes
    // through unchanged - defense in depth must come from callers omitting it.
    const opaque = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    expect(redactText(opaque)).toBe(opaque)
    // A long opaque Base64-ish token is not matched either (long hex is,
    // case-blind, but real tokens are rarely hex).
    const opaqueBase64 = 'Zx9QwErTyUiOpAsDfGhJkLzXcVbNm1234567890abcdeZx9QwErTyUiOp'
    expect(redactText(opaqueBase64)).toBe(opaqueBase64)
  })
})

function fakeContext(credentials?: unknown): Context {
  return {
    get: (name: string) => name === 'credentials' ? credentials : undefined,
  } as unknown as Context
}

describe('vault fallback file', () => {
  it('stores slots in a 0600 file inside a 0700 private directory, atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-vault-'))
    cleanup = root
    const paths = pathsFor(root)
    const vault = new Vault(fakeContext(), paths, silentLog())

    await vault.write('qoder-cn', { pat: 'pat-secret-value', savedAt: 1 })
    const file = join(paths.dataDir, 'secrets.json')
    const fileMode = (await stat(file)).mode & 0o777
    const dirMode = (await stat(paths.dataDir)).mode & 0o777
    expect(fileMode).toBe(0o600)
    expect(dirMode).toBe(0o700)
    expect(await readdir(paths.dataDir)).toEqual(['secrets.json'])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      slots: { 'qoder-cn': { pat: 'pat-secret-value', savedAt: 1 } },
    })

    // A second instance reads the same secret back.
    const reopened = new Vault(fakeContext(), paths, silentLog())
    await expect(reopened.read('qoder-cn')).resolves.toEqual({ pat: 'pat-secret-value', savedAt: 1 })
    await reopened.remove('qoder-cn')
    await expect(reopened.read('qoder-cn')).resolves.toBeUndefined()
    // No temporary file is left behind by the atomic write.
    expect((await readdir(paths.dataDir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps 0600 when overwriting an existing secret file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-vault-'))
    cleanup = root
    const paths = pathsFor(root)
    await mkdir(paths.dataDir, { recursive: true })
    const file = join(paths.dataDir, 'secrets.json')
    await writeFile(file, '{"version":1,"slots":{}}', { mode: 0o644 })
    const vault = new Vault(fakeContext(), paths, silentLog())
    await vault.write('trae-cn', { accessToken: 'x' })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('does not throw when describe() surfaces a credential-service failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-vault-'))
    cleanup = root
    const failingService = {
      async readRecord() { throw new Error('service down') },
      async modifyRecord() { throw new Error('service down') },
      async deleteRecord() { throw new Error('service down') },
      async describeRecord() { throw new Error('service down') },
    }
    const vault = new Vault(fakeContext(failingService), pathsFor(root), silentLog())
    await expect(vault.describe('qoder-cn')).resolves.toEqual({ configured: false, writable: true })
  })
})

describe('atomic writes', () => {
  it('writes 0600 files with no surviving temp siblings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-atomic-'))
    cleanup = root
    const file = join(root, 'state', 'cache.json')
    await writeJsonFile(file, { ok: true })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await writeTextFile(file, 'plain text')
    expect(await readFile(file, 'utf8')).toBe('plain text')
    expect(await readdir(join(root, 'state'))).toEqual(['cache.json'])
  })
})

/** Minimal host credentials seam for the authority tests. */
function fakeCredentialService(): {
  service: {
    readRecord(key: unknown): Promise<{ kind: 'grant'; payload: unknown } | undefined>
    modifyRecord(key: unknown, mutate: (current: { kind: 'grant'; payload: unknown } | undefined) => Promise<{ kind: 'grant'; payload: unknown } | undefined>): Promise<{ kind: 'grant'; payload: unknown } | undefined>
    deleteRecord(key: unknown): Promise<void>
    describeRecord(key: unknown): Promise<{ configured: boolean; writable: boolean }>
  }
  records: Map<unknown, unknown>
} {
  const records = new Map<unknown, unknown>()
  const service = {
    async readRecord(key: unknown) {
      return records.has(key) ? { kind: 'grant' as const, payload: records.get(key) } : undefined
    },
    async modifyRecord(
      key: unknown,
      mutate: (current: { kind: 'grant'; payload: unknown } | undefined) => Promise<{ kind: 'grant'; payload: unknown } | undefined>,
    ) {
      const current = records.has(key) ? { kind: 'grant' as const, payload: records.get(key) } : undefined
      const next = await mutate(current)
      if (next === undefined) return current
      records.set(key, next.payload)
      return next
    },
    async deleteRecord(key: unknown) {
      records.delete(key)
    },
    async describeRecord(key: unknown) {
      return { configured: records.has(key), writable: true }
    },
  }
  return { service, records }
}

async function seedFallback(paths: HubPaths, slots: Record<string, unknown>): Promise<void> {
  await writeJsonFile(join(paths.dataDir, 'secrets.json'), { version: 1, slots })
}

describe('the host credentials service is authoritative over the fallback file', () => {
  it('does not serve a stale fallback slot when the service holds no record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-vault-'))
    cleanup = root
    const paths = pathsFor(root)
    await seedFallback(paths, { 'qoder-cn': { pat: 'stale-fallback-pat', savedAt: 1 } })
    const { service } = fakeCredentialService()
    const vault = new Vault(fakeContext(service), paths, silentLog())
    await expect(vault.read('qoder-cn')).resolves.toBeUndefined()
    await expect(vault.describe('qoder-cn')).resolves.toEqual({ configured: false, writable: true })
  })

  it('drops the fallback copy when a record is written to the service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-vault-'))
    cleanup = root
    const paths = pathsFor(root)
    await seedFallback(paths, { 'qoder-cn': { pat: 'stale-fallback-pat', savedAt: 1 } })
    const { service } = fakeCredentialService()
    const vault = new Vault(fakeContext(service), paths, silentLog())
    await vault.write('qoder-cn', { pat: 'fresh-service-pat', savedAt: 2 })
    const fallback = JSON.parse(await readFile(join(paths.dataDir, 'secrets.json'), 'utf8')) as {
      slots: Record<string, unknown>
    }
    expect(fallback.slots['qoder-cn']).toBeUndefined()
    await expect(vault.read('qoder-cn')).resolves.toEqual({ pat: 'fresh-service-pat', savedAt: 2 })
  })

  it('drops the fallback copy when a record is removed through the service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-vault-'))
    cleanup = root
    const paths = pathsFor(root)
    await seedFallback(paths, { 'qoder-cn': { pat: 'stale-fallback-pat', savedAt: 1 } })
    const { service, records } = fakeCredentialService()
    const vault = new Vault(fakeContext(service), paths, silentLog())
    await vault.write('qoder-cn', { pat: 'service-pat', savedAt: 2 })
    expect(records.size).toBe(1)
    await vault.remove('qoder-cn')
    expect(records.size).toBe(0)
    const fallback = JSON.parse(await readFile(join(paths.dataDir, 'secrets.json'), 'utf8')) as {
      slots: Record<string, unknown>
    }
    expect(fallback.slots['qoder-cn']).toBeUndefined()
  })

  it('still reads the fallback file when the service is absent (offline behaviour preserved)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-vault-'))
    cleanup = root
    const paths = pathsFor(root)
    await seedFallback(paths, { 'qoder-cn': { pat: 'offline-pat', savedAt: 1 } })
    const vault = new Vault(fakeContext(), paths, silentLog())
    await expect(vault.read('qoder-cn')).resolves.toEqual({ pat: 'offline-pat', savedAt: 1 })
  })
})
