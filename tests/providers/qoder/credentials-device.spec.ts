/**
 * Device-credential store: persistence (including the v1 PAT migration),
 * proactive rotation, single-flight, failure degradation and desktop re-import.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SecretSlot, Vault } from '../../../src/core/vault.ts'
import type { QoderDesktopCredential, QoderDeviceRefreshOutcome } from '../../../src/providers/qoder/desktop-auth.ts'
import {
  QoderCredentialStore,
  type QoderDeviceCredential,
} from '../../../src/providers/qoder/credentials.ts'
import { QODER_CN_VARIANT } from '../../../src/providers/qoder/variants.ts'
import { MemoryVault } from './host.ts'

const HOUR = 3_600_000

function store(
  vault: MemoryVault,
  refresh?: (credential: QoderDeviceCredential, signal?: AbortSignal) => Promise<QoderDeviceRefreshOutcome>,
) {
  return new QoderCredentialStore({
    vault: vault as unknown as Vault,
    variant: QODER_CN_VARIANT,
    ...refresh === undefined ? {} : { refresh },
  })
}

function imported(overrides: Partial<QoderDesktopCredential> = {}): QoderDesktopCredential {
  return {
    token: 'dt-initial',
    refreshToken: 'drt-initial',
    expiresAtMs: Date.now() + 30 * 24 * HOUR,
    refreshTokenExpiresAtMs: Date.now() + 365 * 24 * HOUR,
    user: { id: 'account-1', name: 'Tester', email: 'tester@example.com' },
    ...overrides,
  }
}

/** A vault whose writes can be held open or made to fail (race testing). */
class ControllableVault extends MemoryVault {
  gate: Promise<void> | undefined
  onWriteStart: (() => void) | undefined
  failWrites = false

  override async write<T>(slot: SecretSlot, value: T): Promise<void> {
    this.onWriteStart?.()
    if (this.gate !== undefined) await this.gate
    if (this.failWrites) throw new Error('disk full')
    await super.write(slot, value)
  }
}

function outcome(token: string, refreshToken: string): QoderDeviceRefreshOutcome {
  return {
    token,
    refreshToken,
    expiresAtMs: Date.now() + 30 * 24 * HOUR,
    refreshTokenExpiresAtMs: Date.now() + 365 * 24 * HOUR,
  }
}

describe('QoderCredentialStore device credentials', () => {
  it('loads the legacy version-1 PAT payload unchanged', async () => {
    const vault = new MemoryVault()
    vault.slots.set('qoder-cn', { version: 1, pat: 'pt-legacy', savedAt: 42 })
    const credentials = store(vault)
    expect(await credentials.load()).toMatchObject({ kind: 'pat', pat: 'pt-legacy', savedAtMs: 42 })
    expect(credentials.summary()).toMatchObject({ configured: true, kind: 'pat', masked: '****gacy' })
  })

  it('persists a PAT in the original version-1 shape', async () => {
    const vault = new MemoryVault()
    const credentials = store(vault)
    await credentials.savePat('pt-saved')
    expect(vault.slots.get('qoder-cn')).toMatchObject({ version: 1, pat: 'pt-saved' })
  })

  it('round-trips a desktop credential through the version-2 payload', async () => {
    const vault = new MemoryVault()
    const credentials = store(vault)
    await credentials.saveDevice(imported())
    expect(vault.slots.get('qoder-cn')).toMatchObject({ version: 2, kind: 'device', token: 'dt-initial' })

    const reloaded = store(vault)
    const loaded = await reloaded.load()
    expect(loaded).toMatchObject({ kind: 'device', token: 'dt-initial', refreshToken: 'drt-initial', source: 'desktop' })
    expect(reloaded.summary()).toMatchObject({
      configured: true,
      kind: 'device',
      accountId: 'account-1',
      accountName: 'Tester',
      accountEmail: 'tester@example.com',
      masked: '****tial',
    })
    expect(reloaded.identity()).toBe('device:account-1')
  })

  it('keeps the device identity stable across token rotation', async () => {
    let calls = 0
    const vault = new MemoryVault()
    const credentials = store(vault, async () => {
      calls += 1
      return outcome(`dt-rotated-${calls}`, `drt-rotated-${calls}`)
    })
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 60_000 }))
    const before = credentials.identity()
    expect(await credentials.rotate()).toBe('dt-rotated-1')
    expect(credentials.identity()).toBe(before)
    expect(credentials.summary().accountId).toBe('account-1')
  })

  it('returns the stored token without rotating while it is comfortably valid', async () => {
    const refresh = vi.fn()
    const credentials = store(new MemoryVault(), refresh)
    await credentials.saveDevice(imported())
    await expect(credentials.accessToken()).resolves.toBe('dt-initial')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('rotates proactively near expiry and persists the rotated pair', async () => {
    const vault = new MemoryVault()
    const refresh = vi.fn(async () => outcome('dt-rotated', 'drt-rotated'))
    const credentials = store(vault, refresh)
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 60_000 }))
    await expect(credentials.accessToken()).resolves.toBe('dt-rotated')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(vault.slots.get('qoder-cn')).toMatchObject({
      kind: 'device',
      token: 'dt-rotated',
      refreshToken: 'drt-rotated',
    })
    await expect(credentials.accessToken()).resolves.toBe('dt-rotated')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('shares one rotation across concurrent readers', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const refresh = vi.fn(async () => {
      await gate
      return outcome('dt-rotated', 'drt-rotated')
    })
    const credentials = store(new MemoryVault(), refresh)
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 60_000 }))
    const first = credentials.accessToken()
    const second = credentials.accessToken()
    release()
    await expect(Promise.all([first, second])).resolves.toEqual(['dt-rotated', 'dt-rotated'])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('never resurrects a credential cleared while a rotation was in flight', async () => {
    let release: (value: QoderDeviceRefreshOutcome) => void = () => {}
    const gate = new Promise<QoderDeviceRefreshOutcome>((resolve) => { release = resolve })
    const vault = new MemoryVault()
    const credentials = store(vault, async () => await gate)
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 60_000 }))
    const pending = credentials.accessToken().catch(error => error)
    await credentials.clear()
    release(outcome('dt-late', 'drt-late'))
    await pending
    expect(credentials.current()).toBeUndefined()
    expect(vault.slots.has('qoder-cn')).toBe(false)
  })

  it('never overwrites a PAT saved while a rotation was in flight', async () => {
    let release: (value: QoderDeviceRefreshOutcome) => void = () => {}
    const gate = new Promise<QoderDeviceRefreshOutcome>((resolve) => { release = resolve })
    const vault = new MemoryVault()
    const credentials = store(vault, async () => await gate)
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 60_000 }))
    const pending = credentials.accessToken().catch(error => error)
    await credentials.savePat('pt-user-manual')
    release(outcome('dt-late', 'drt-late'))
    await pending
    expect(credentials.current()).toMatchObject({ kind: 'pat', pat: 'pt-user-manual' })
    expect(vault.slots.get('qoder-cn')).toMatchObject({ version: 1, pat: 'pt-user-manual' })
  })

  it('does not resurrect the credential when clear lands during the rotation write', async () => {
    const vault = new ControllableVault()
    const credentials = store(vault, async () => outcome('dt-late', 'drt-late'))
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 60_000 }))
    let release: () => void = () => {}
    vault.gate = new Promise<void>((resolve) => { release = resolve })
    let started: () => void = () => {}
    const writeStarted = new Promise<void>((resolve) => { started = resolve })
    vault.onWriteStart = () => started()
    const pending = credentials.accessToken().catch(error => error)
    await writeStarted
    const clearing = credentials.clear()
    release()
    await clearing
    await pending
    expect(credentials.current()).toBeUndefined()
    expect(vault.slots.has('qoder-cn')).toBe(false)
  })

  it('keeps a PAT saved while the rotation write is still pending', async () => {
    const vault = new ControllableVault()
    const credentials = store(vault, async () => outcome('dt-late', 'drt-late'))
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 60_000 }))
    let release: () => void = () => {}
    vault.gate = new Promise<void>((resolve) => { release = resolve })
    let started: () => void = () => {}
    const writeStarted = new Promise<void>((resolve) => { started = resolve })
    vault.onWriteStart = () => started()
    const pending = credentials.accessToken().catch(error => error)
    await writeStarted
    const saving = credentials.savePat('pt-user-manual')
    release()
    await saving
    await pending
    expect(credentials.current()).toMatchObject({ kind: 'pat', pat: 'pt-user-manual' })
    expect(vault.slots.get('qoder-cn')).toMatchObject({ version: 1, pat: 'pt-user-manual' })
  })

  it('aborts an in-flight rotation when the credential is cleared', async () => {
    let seen: AbortSignal | undefined
    let aborted: () => void = () => {}
    const abortObserved = new Promise<void>((resolve) => { aborted = resolve })
    const credentials = store(new MemoryVault(), async (_credential, signal) => {
      seen = signal
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted()
          reject(new Error('rotation aborted'))
        })
        setTimeout(resolve, 5_000)
      })
      return outcome('dt-late', 'drt-late')
    })
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 60_000 }))
    const pending = credentials.accessToken().catch(error => error)
    await vi.waitFor(() => { expect(seen).toBeDefined() })
    await credentials.clear()
    await abortObserved
    await pending
    expect(seen?.aborted).toBe(true)
  })

  it('restores the cached credential when a device write fails', async () => {
    const vault = new ControllableVault()
    vault.slots.set('qoder-cn', { version: 1, pat: 'pt-old', savedAt: 1 })
    const credentials = store(vault)
    vault.failWrites = true
    await expect(credentials.saveDevice(imported())).rejects.toThrow(/disk full/u)
    expect(credentials.current()).toMatchObject({ kind: 'pat', pat: 'pt-old' })
  })

  it('retries with the new credential when save lands during its rotation', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started: () => void = () => {}
    const refreshStarted = new Promise<void>((resolve) => { started = resolve })
    const credentials = store(new MemoryVault(), async (_credential, signal) => {
      started()
      await gate
      signal?.throwIfAborted()
      return outcome('dt-late', 'drt-late')
    })
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 60_000 }))
    const pending = credentials.accessToken()
    await refreshStarted
    await credentials.savePat('pt-new')
    release()
    await expect(pending).resolves.toBe('pt-new')
  })

  it('joins an in-flight proactive rotation instead of refreshing twice', async () => {
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const credentials = store(new MemoryVault(), async () => {
      calls += 1
      await gate
      return outcome('dt-rotated', 'drt-rotated')
    })
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 60_000 }))
    const proactive = credentials.accessToken()
    const healed = credentials.rotate()
    release()
    await expect(Promise.all([proactive, healed])).resolves.toEqual(['dt-rotated', 'dt-rotated'])
    expect(calls).toBe(1)
  })

  it('backs off after a failed rotation instead of retrying on every read', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('upstream down')
    })
    const credentials = store(new MemoryVault(), refresh)
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 5 * 60_000 }))
    await expect(credentials.accessToken()).resolves.toBe('dt-initial')
    expect(refresh).toHaveBeenCalledTimes(1)
    // Inside the cooldown the still-valid token is used without another call.
    await expect(credentials.accessToken()).resolves.toBe('dt-initial')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('forces a rotation for the transport self-heal', async () => {
    const refresh = vi.fn(async () => outcome('dt-healed', 'drt-healed'))
    const credentials = store(new MemoryVault(), refresh)
    await credentials.saveDevice(imported())
    await expect(credentials.rotate()).resolves.toBe('dt-healed')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('degrades to the still-valid token when rotation fails, and reports why', async () => {
    const credentials = store(new MemoryVault(), async () => {
      throw new Error('refresh rejected')
    })
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 5 * 60_000 }))
    await expect(credentials.accessToken()).resolves.toBe('dt-initial')
    expect(credentials.lastRefreshError()).toContain('refresh rejected')
  })

  it('fails closed once the token is expired and rotation keeps failing', async () => {
    const credentials = store(new MemoryVault(), async () => {
      throw new Error('refresh rejected')
    })
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() - 1 }))
    await expect(credentials.accessToken()).rejects.toThrow(/MISSING_CREDENTIAL/u)
  })

  it('fails closed when an expired credential has no refresh token', async () => {
    const credentials = store(new MemoryVault())
    await credentials.saveDevice(imported({ refreshToken: '', expiresAtMs: Date.now() - 1 }))
    await expect(credentials.accessToken()).rejects.toThrow(/MISSING_CREDENTIAL/u)
  })

  it('rejects rotation for a PAT credential', async () => {
    const credentials = store(new MemoryVault())
    await credentials.savePat('pt-only')
    await expect(credentials.rotate()).rejects.toThrow(/MISSING_CREDENTIAL/u)
  })

  it('adopts a newer desktop record for the same account', async () => {
    const vault = new MemoryVault()
    const credentials = store(vault)
    await credentials.saveDevice(imported({ expiresAtMs: Date.now() + 24 * HOUR }))
    expect(await credentials.mergeDesktop(imported({ token: 'dt-newer', expiresAtMs: Date.now() + 48 * HOUR }))).toBe(true)
    expect(credentials.summary().masked).toBe('****ewer')
  })

  it('ignores a stale desktop record and preserves the hub-rotated pair', async () => {
    const credentials = store(new MemoryVault())
    await credentials.saveDevice(imported({ token: 'dt-hub', expiresAtMs: Date.now() + 48 * HOUR }))
    expect(await credentials.mergeDesktop(imported({ token: 'dt-stale', expiresAtMs: Date.now() + 24 * HOUR }))).toBe(false)
    await expect(credentials.accessToken()).resolves.toBe('dt-hub')
  })

  it('adopts a different desktop account but never an anonymous record over a known one', async () => {
    const credentials = store(new MemoryVault())
    await credentials.saveDevice(imported())
    expect(await credentials.mergeDesktop(imported({ user: { id: '' }, token: 'dt-anon' }))).toBe(false)
    expect(await credentials.mergeDesktop(imported({ user: { id: 'account-2', name: 'Other' }, token: 'dt-other' }))).toBe(true)
    expect(credentials.identity()).toBe('device:account-2')
  })

  it('does not replace a manually saved PAT with a desktop record', async () => {
    const credentials = store(new MemoryVault())
    await credentials.savePat('pt-manual')
    expect(await credentials.mergeDesktop(imported())).toBe(false)
    await expect(credentials.accessToken()).resolves.toBe('pt-manual')
  })

  it('clears the vault slot and cached credential', async () => {
    const vault = new MemoryVault()
    const credentials = store(vault)
    await credentials.saveDevice(imported())
    await credentials.clear()
    expect(vault.slots.has('qoder-cn')).toBe(false)
    expect(credentials.summary()).toEqual({ configured: false })
    expect(await credentials.load()).toBeUndefined()
  })
})
