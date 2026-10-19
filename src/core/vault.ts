import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { readJsonFile, writeJsonFile } from './atomic.ts'
import type { HubLogger } from './log.ts'
import type { HubPaths } from './paths.ts'

export type SecretSlot =
  | 'qoder-cn'
  | 'qoder-global'
  | 'workbuddy-cn'
  | 'workbuddy-ai'
  | 'trae-cn'
  | 'trae-global'

export interface SecretInfo {
  configured: boolean
  writable: boolean
}

interface CredentialService {
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>
  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>
  deleteRecord(key: CredentialKey): Promise<void>
  describeRecord(key: CredentialKey): Promise<{ configured: boolean; writable: boolean }>
}

interface FallbackFile {
  version: 1
  slots: Record<string, unknown>
}

const FALLBACK_FILENAME = 'secrets.json'
const SCOPE = 'dsh-connect-hub'

export class Vault {
  private readonly ctx: Context
  private readonly fallbackPath: string
  private readonly log: HubLogger
  private fallback: FallbackFile | undefined
  private readonly pending = new Map<SecretSlot, Promise<unknown>>()

  constructor(ctx: Context, paths: HubPaths, log: HubLogger) {
    this.ctx = ctx
    this.fallbackPath = `${paths.dataDir}/${FALLBACK_FILENAME}`
    this.log = log.child('vault')
  }

  /** Resolved per operation: the credential seam may arrive after this plugin. */
  private service(): CredentialService | undefined {
    return this.ctx.get?.('credentials') as CredentialService | undefined
  }

  private key(slot: SecretSlot): CredentialKey {
    return credentialKey(SCOPE, slot)
  }

  private async loadFallback(): Promise<FallbackFile> {
    if (this.fallback !== undefined) return this.fallback
    const stored = await readJsonFile<FallbackFile>(this.fallbackPath)
    this.fallback = stored !== undefined && stored.version === 1 && typeof stored.slots === 'object' && stored.slots !== null
      ? stored
      : { version: 1, slots: {} }
    return this.fallback
  }

  private async saveFallback(): Promise<void> {
    await writeJsonFile(this.fallbackPath, await this.loadFallback())
  }

  async read<T>(slot: SecretSlot): Promise<T | undefined> {
    const service = this.service()
    if (service !== undefined) {
      const record = await service.readRecord(this.key(slot))
      return payloadOf(record) as T | undefined
    }
    const fallback = await this.loadFallback()
    return fallback.slots[slot] as T | undefined
  }

  async write<T>(slot: SecretSlot, value: T): Promise<void> {
    const service = this.service()
    if (service !== undefined) {
      await service.modifyRecord(this.key(slot), async () => ({ kind: 'grant', payload: value }))
      await this.dropFallbackSlot(slot)
      return
    }
    const fallback = await this.loadFallback()
    fallback.slots[slot] = value
    await this.saveFallback()
  }

  async modify<T>(slot: SecretSlot, mutate: (current: T | undefined) => Promise<T | undefined> | T | undefined): Promise<T | undefined> {
    const previous = this.pending.get(slot)
    const run = (): Promise<T | undefined> => this.modifyOnce(slot, mutate)
    const next = previous === undefined ? run() : previous.then(run, run)
    this.pending.set(slot, next)
    try {
      return await next
    } finally {
      if (this.pending.get(slot) === next) this.pending.delete(slot)
    }
  }

  private async modifyOnce<T>(
    slot: SecretSlot,
    mutate: (current: T | undefined) => Promise<T | undefined> | T | undefined,
  ): Promise<T | undefined> {
    const service = this.service()
    if (service !== undefined) {
      let result: T | undefined
      await service.modifyRecord(this.key(slot), async (current) => {
        const updated = await mutate(payloadOf(current) as T | undefined)
        if (updated === undefined) return current
        result = updated
        return { kind: 'grant', payload: updated }
      })
      return result
    }
    const fallback = await this.loadFallback()
    const updated = await mutate(fallback.slots[slot] as T | undefined)
    if (updated === undefined) return undefined
    fallback.slots[slot] = updated
    await this.saveFallback()
    return updated
  }

  async remove(slot: SecretSlot): Promise<void> {
    const service = this.service()
    if (service !== undefined) {
      await service.deleteRecord(this.key(slot))
      await this.dropFallbackSlot(slot)
      return
    }
    const fallback = await this.loadFallback()
    if (slot in fallback.slots) {
      delete fallback.slots[slot]
      await this.saveFallback()
    }
  }

  /** A record moved to the host seam must not reappear from the offline file. */
  private async dropFallbackSlot(slot: SecretSlot): Promise<void> {
    const fallback = await this.loadFallback()
    if (!(slot in fallback.slots)) return
    delete fallback.slots[slot]
    await this.saveFallback()
  }

  async describe(slot: SecretSlot): Promise<SecretInfo> {
    const service = this.service()
    if (service !== undefined) {
      try {
        const info = await service.describeRecord(this.key(slot))
        return { configured: info.configured, writable: info.writable }
      } catch (error) {
        this.log.warn(`credential record unavailable: ${errorText(error)}`)
        return { configured: false, writable: true }
      }
    }
    const fallback = await this.loadFallback()
    return { configured: fallback.slots[slot] !== undefined, writable: true }
  }
}

function payloadOf(record: CredentialRecord | undefined): unknown {
  if (record === undefined || record.kind !== 'grant') return undefined
  return record.payload
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
