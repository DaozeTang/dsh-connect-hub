import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Vault } from '../../src/core/vault.ts'
import type { HubPaths } from '../../src/core/paths.ts'
import type { Context } from '@deepseek-ai/cordis'

const cleanups: string[] = []

async function makePaths(): Promise<HubPaths> {
  const root = await mkdtemp(join(tmpdir(), 'hub-vault-'))
  cleanups.push(root)
  return { home: root, dataDir: join(root, 'data'), stateDir: join(root, 'data', 'state') }
}

function silentLog() {
  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log }
  return log
}

function fakeContext(credentials?: unknown): Context {
  return { get: (name: string) => (name === 'credentials' ? credentials : undefined) } as unknown as Context
}

class FakeCredentials {
  records = new Map<string, { kind: 'grant'; payload: unknown }>()
  async readRecord(key: { toString(): string }) { return this.records.get(String(key)) }
  async modifyRecord(key: { toString(): string }, mutate: (current: unknown) => Promise<unknown>) {
    const current = this.records.get(String(key))
    const next = (await mutate(current)) as { kind: 'grant'; payload: unknown } | undefined
    if (next === undefined) return current
    this.records.set(String(key), next)
    return next
  }
  async deleteRecord(key: { toString(): string }) { this.records.delete(String(key)) }
  async describeRecord(key: { toString(): string }) { return { configured: this.records.has(String(key)), writable: true } }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Vault', () => {
  it('falls back to a private file when the host has no credential service', async () => {
    const paths = await makePaths()
    const vault = new Vault(fakeContext(), paths, silentLog() as never)
    await vault.write('qoder-cn', { pat: 'secret' })
    expect(await vault.read('qoder-cn')).toEqual({ pat: 'secret' })
    expect(await vault.describe('qoder-cn')).toEqual({ configured: true, writable: true })
    const file = join(paths.dataDir, 'secrets.json')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, slots: { 'qoder-cn': { pat: 'secret' } } })
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    await vault.remove('qoder-cn')
    expect(await vault.read('qoder-cn')).toBeUndefined()
  })

  it('uses credential records when the host serves the seam', async () => {
    const paths = await makePaths()
    const credentials = new FakeCredentials()
    const vault = new Vault(fakeContext(credentials), paths, silentLog() as never)
    await vault.write('trae-cn', { accounts: [{ id: '1' }] })
    expect(credentials.records.size).toBe(1)
    expect(await vault.read('trae-cn')).toEqual({ accounts: [{ id: '1' }] })
  })

  it('serializes concurrent modify calls per slot', async () => {
    const paths = await makePaths()
    const vault = new Vault(fakeContext(new FakeCredentials()), paths, silentLog() as never)
    await vault.write<{ count: number }>('workbuddy-cn', { count: 0 })
    await Promise.all(Array.from({ length: 20 }, () => vault.modify<{ count: number }>('workbuddy-cn', async (current) => ({ count: (current?.count ?? 0) + 1 }))))
    expect(await vault.read('workbuddy-cn')).toEqual({ count: 20 })
  })

  it('a declined modify leaves the previous value untouched', async () => {
    const paths = await makePaths()
    const vault = new Vault(fakeContext(), paths, silentLog() as never)
    await vault.write('qoder-global', { pat: 'a' })
    const result = await vault.modify('qoder-global', () => undefined)
    expect(result).toBeUndefined()
    expect(await vault.read('qoder-global')).toEqual({ pat: 'a' })
  })
})
