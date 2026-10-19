/**
 * Provider-level desktop login: automatic import on boot, explicit import,
 * validation, sign-out semantics and the background merge of a re-sign-in.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QoderDesktopCredential, QoderDesktopReadResult } from '../../../src/providers/qoder/desktop-auth.ts'
import type { QoderCredentialStore } from '../../../src/providers/qoder/credentials.ts'
import { createQoderRuntime } from '../../../src/providers/qoder/provider.ts'
import { QODER_CN_VARIANT } from '../../../src/providers/qoder/variants.ts'
import { harness } from './host.ts'
import { json } from './fakes.ts'

const HOUR = 3_600_000

let cleanup: string | undefined
afterEach(async () => {
  vi.unstubAllGlobals()
  if (cleanup !== undefined) {
    await rm(cleanup, { recursive: true, force: true })
    cleanup = undefined
  }
})

function desktopCredential(overrides: Partial<QoderDesktopCredential> = {}): QoderDesktopCredential {
  return {
    token: 'dt-desktop',
    refreshToken: 'drt-desktop',
    expiresAtMs: Date.now() + 30 * 24 * HOUR,
    refreshTokenExpiresAtMs: Date.now() + 365 * 24 * HOUR,
    user: { id: 'user-123', name: 'Tester', email: 'tester@example.com' },
    ...overrides,
  }
}

function found(credential: QoderDesktopCredential): QoderDesktopReadResult {
  return { state: 'found', credential, path: '/fake/auth.v1.dat' }
}

function absent(): QoderDesktopReadResult {
  return { state: 'absent', code: 'not-found', checked: ['/fake/auth.v1.dat'] }
}

async function makeRuntime(reader: () => Promise<QoderDesktopReadResult>) {
  const root = await mkdtemp(join(tmpdir(), 'qoder-desktop-login-'))
  cleanup = root
  const hosted = harness(root)
  const runtime = createQoderRuntime(hosted.deps, QODER_CN_VARIANT, { readDesktopAuth: reader })
  return { hosted, runtime }
}

interface DesktopLoginInternals {
  store: QoderCredentialStore
  syncCredentials(): Promise<void>
  lastDesktopProbeAt: number
  authFailure: boolean
}

function internals(runtime: object): DesktopLoginInternals {
  return runtime as unknown as DesktopLoginInternals
}

/** Wait for the background boot import to adopt the desktop sign-in. */
async function waitForAppLogin(runtime: { status(): { credential?: { source: string } } }): Promise<void> {
  await vi.waitFor(() => {
    expect(runtime.status().credential?.source).toBe('app')
  })
}

/** Answer the identity read and 404 everything else (background refreshes). */
function stubIdentity(status = 200, id = 'user-123'): void {
  vi.stubGlobal('fetch', (async (input: unknown) => {
    const url = String(input)
    if (url.endsWith('/api/v1/userinfo')) {
      if (status !== 200) return new Response('rejected', { status })
      return json({ id, name: 'Tester', email: 'tester@example.com' })
    }
    return new Response('', { status: 404 })
  }) as typeof fetch)
}

describe('Qoder desktop login provider integration', () => {
  it('imports the desktop sign-in on boot and reports it as an app credential', async () => {
    stubIdentity()
    const { hosted, runtime } = await makeRuntime(async () => found(desktopCredential()))
    await runtime.init()
    try {
      await waitForAppLogin(runtime)
      const status = runtime.status()
      expect(status.state).toBe('ready')
      expect(status.credential).toMatchObject({ source: 'app', writable: false })
      expect(status.credential?.expiresAt).toBeGreaterThan(Date.now())
      expect(status.account).toMatchObject({ label: 'Tester', detail: 't***@example.com' })
      expect(hosted.vault.slots.get('qoder-cn')).toMatchObject({ version: 2, kind: 'device', token: 'dt-desktop' })
    } finally {
      await runtime.dispose()
    }
  })

  it('stays signed out with an honest warning when no desktop sign-in exists', async () => {
    const { runtime } = await makeRuntime(async () => absent())
    await runtime.init()
    try {
      await vi.waitFor(() => {
        expect(runtime.status().warnings.map(warning => warning.code)).toContain('no-credential')
      })
      const status = runtime.status()
      expect(status.state).toBe('needs-credential')
      expect(status.credential).toBeUndefined()
      expect(status.warnings).toEqual([
        expect.objectContaining({ code: 'no-credential', level: 'info' }),
      ])
      await expect(runtime.action({ type: 'import-desktop-login', provider: 'qoder' }))
        .rejects.toMatchObject({ code: 'desktop_login_not_found' })
    } finally {
      await runtime.dispose()
    }
  })

  it('validates a desktop token against the region before the explicit import is stored', async () => {
    stubIdentity(401)
    const { hosted, runtime } = await makeRuntime(async () => found(desktopCredential()))
    // Boot adopts without a network round trip; the explicit import validates.
    await runtime.init()
    try {
      await waitForAppLogin(runtime)
      expect(hosted.vault.slots.get('qoder-cn')).toMatchObject({ kind: 'device' })
      await expect(runtime.action({ type: 'import-desktop-login', provider: 'qoder' }))
        .rejects.toMatchObject({ code: 'desktop_login_rejected' })
      // The boot-adopted credential stays in place; only the requested
      // re-read was refused, and the action itself reports it.
      expect(runtime.status().credential?.source).toBe('app')
      expect(hosted.vault.slots.get('qoder-cn')).toMatchObject({ kind: 'device', user: { id: 'user-123' } })
    } finally {
      await runtime.dispose()
    }
  })

  it('adopts an imported sign-in on request and enables automatic import', async () => {
    stubIdentity(200, 'user-999')
    let result: QoderDesktopReadResult = absent()
    const { hosted, runtime } = await makeRuntime(async () => result)
    await runtime.init()
    try {
      expect(runtime.status().state).toBe('needs-credential')
      // The app signs in while the hub is running; the user clicks re-read.
      result = found(desktopCredential({ user: { id: 'user-999', name: 'Later' } }))
      const outcome = await runtime.action({ type: 'import-desktop-login', provider: 'qoder' })
      expect(outcome.message).toContain('Later')
      expect(hosted.vault.slots.get('qoder-cn')).toMatchObject({ kind: 'device', user: { id: 'user-999' } })
      expect((hosted.prefs.values.get('provider:qoder') as { autoLogin?: boolean }).autoLogin).toBe(true)
      expect(runtime.status()).toMatchObject({
        state: 'ready',
        credential: { source: 'app' },
        account: { label: 'Later' },
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('does not downgrade a fresher hub-rotated pair on an explicit re-read', async () => {
    stubIdentity()
    const { hosted, runtime } = await makeRuntime(async () => found(desktopCredential({ token: 'dt-desktop', expiresAtMs: Date.now() + HOUR })))
    await runtime.init()
    try {
      await waitForAppLogin(runtime)
      const state = internals(runtime)
      // Simulate the hub having rotated to a much fresher pair.
      await state.store.saveDevice(desktopCredential({
        token: 'dt-hub-rotated',
        refreshToken: 'drt-hub-rotated',
        expiresAtMs: Date.now() + 30 * 24 * HOUR,
      }))
      const outcome = await runtime.action({ type: 'import-desktop-login', provider: 'qoder' })
      expect(outcome.message).toContain('最新')
      expect(hosted.vault.slots.get('qoder-cn')).toMatchObject({ token: 'dt-hub-rotated' })
    } finally {
      await runtime.dispose()
    }
  })

  it('does not downgrade an anonymous hub pair with a stale desktop record', async () => {
    stubIdentity()
    const { hosted, runtime } = await makeRuntime(async () => found(desktopCredential({
      token: 'dt-desktop-stale',
      user: { id: 'user-123', name: 'Tester' },
      expiresAtMs: Date.now() + HOUR,
    })))
    await runtime.init()
    try {
      await waitForAppLogin(runtime)
      const state = internals(runtime)
      await state.store.saveDevice(desktopCredential({
        token: 'dt-hub-anonymous',
        user: { id: '' },
        expiresAtMs: Date.now() + 48 * HOUR,
      }))
      const outcome = await runtime.action({ type: 'import-desktop-login', provider: 'qoder' })
      expect(outcome.message).toContain('最新')
      expect(hosted.vault.slots.get('qoder-cn')).toMatchObject({ token: 'dt-hub-anonymous' })
    } finally {
      await runtime.dispose()
    }
  })

  it('saves a PAT explicitly and turns automatic import off', async () => {
    stubIdentity()
    const reader = vi.fn(async () => found(desktopCredential()))
    const { hosted, runtime } = await makeRuntime(reader)
    await runtime.init()
    try {
      // The app has no sign-in yet; saving a PAT is an explicit choice.
      hosted.vault.slots.set('qoder-cn', { version: 1, pat: 'pt-validated', savedAt: 1 })
      const state = internals(runtime)
      // Drive through the public action so the real validation path runs.
      vi.stubGlobal('fetch', (async (input: unknown) => {
        const url = String(input)
        if (url.endsWith('/api/v1/jobToken/exchange')) return json({ token: 'jt-1', expires_in: 3_600_000 })
        if (url.endsWith('/api/v1/userinfo')) return json({ id: 'user-123', name: 'Tester' })
        if (url.includes('/api/v2/model/list')) return json({ assistant: [{ key: 'cmodel', display_name: 'C', enable: true, max_input_tokens: 1000 }] })
        return new Response('', { status: 404 })
      }) as typeof fetch)
      await runtime.action({ type: 'save-secret', provider: 'qoder', secret: 'pt-validated' })
      expect((hosted.prefs.values.get('provider:qoder') as { autoLogin?: boolean }).autoLogin).toBe(false)
      expect(state.store.current()).toMatchObject({ kind: 'pat' })
    } finally {
      await runtime.dispose()
    }
  })

  it('does not probe the desktop file on a signed-out boot with autoLogin off', async () => {
    const reader = vi.fn(async () => found(desktopCredential()))
    const { hosted, runtime } = await makeRuntime(reader)
    hosted.prefs.values.set('provider:qoder', { disabledModels: [], useMaxContext: false, autoLogin: false, checkin: { enabled: false, minute: 600, logs: [] } })
    await runtime.init()
    try {
      expect(reader).not.toHaveBeenCalled()
      expect(runtime.status().state).toBe('needs-credential')
      expect(runtime.status().warnings).toEqual([
        expect.objectContaining({ code: 'credential-missing' }),
      ])
    } finally {
      await runtime.dispose()
    }
  })

  it('clears an app credential and then leaves the signed-out state alone', async () => {
    stubIdentity()
    const reader = vi.fn(async () => found(desktopCredential()))
    const { hosted, runtime } = await makeRuntime(reader)
    await runtime.init()
    try {
      await waitForAppLogin(runtime)
      await runtime.action({ type: 'clear-secret', provider: 'qoder' })
      expect(hosted.vault.slots.has('qoder-cn')).toBe(false)
      expect((hosted.prefs.values.get('provider:qoder') as { autoLogin?: boolean }).autoLogin).toBe(false)
      expect(runtime.status().state).toBe('needs-credential')
    } finally {
      await runtime.dispose()
    }

    // A restarted plugin must respect the sign-out instead of re-importing.
    const second = createQoderRuntime(hosted.deps, QODER_CN_VARIANT, { readDesktopAuth: reader })
    await second.init()
    try {
      expect(second.status().state).toBe('needs-credential')
      expect(hosted.vault.slots.has('qoder-cn')).toBe(false)
      // An explicit re-read turns automatic import back on.
      stubIdentity()
      await second.action({ type: 'import-desktop-login', provider: 'qoder' })
      expect((hosted.prefs.values.get('provider:qoder') as { autoLogin?: boolean }).autoLogin).toBe(true)
      expect(second.status().credential?.source).toBe('app')
    } finally {
      await second.dispose()
    }
  })

  it('follows a newer desktop sign-in during the credential sweep', async () => {
    stubIdentity()
    let current = desktopCredential({ token: 'dt-first', expiresAtMs: Date.now() + HOUR })
    const { hosted, runtime } = await makeRuntime(async () => found(current))
    await runtime.init()
    try {
      await vi.waitFor(() => {
        expect(internals(runtime).store.summary().masked).toBe('****irst')
      })
      const state = internals(runtime)
      current = desktopCredential({ token: 'dt-second', expiresAtMs: Date.now() + 2 * HOUR })
      state.lastDesktopProbeAt = 0
      await state.syncCredentials()
      await vi.waitFor(() => {
        expect(state.store.summary().masked).toBe('****cond')
      })
      expect(hosted.vault.slots.get('qoder-cn')).toMatchObject({ token: 'dt-second' })
    } finally {
      await runtime.dispose()
    }
  })

  it('never replaces a manually saved PAT with the desktop sign-in', async () => {
    stubIdentity()
    const { hosted, runtime } = await makeRuntime(async () => found(desktopCredential()))
    hosted.vault.slots.set('qoder-cn', { version: 1, pat: 'pt-manual', savedAt: 1 })
    await runtime.init()
    try {
      expect(runtime.status().credential?.source).toBe('plugin')
      const state = internals(runtime)
      state.lastDesktopProbeAt = 0
      await state.syncCredentials()
      expect(state.store.current()).toMatchObject({ kind: 'pat', pat: 'pt-manual' })
    } finally {
      await runtime.dispose()
    }
  })

  it('reports a rejected desktop sign-in as a credential error', async () => {
    stubIdentity(401)
    const { runtime } = await makeRuntime(async () => found(desktopCredential()))
    await runtime.init()
    try {
      await waitForAppLogin(runtime)
      await expect(runtime.action({ type: 'refresh-catalog', provider: 'qoder' })).rejects.toBeDefined()
      const status = runtime.status()
      expect(status.state).toBe('error')
      expect(status.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'desktop-credential-rejected', message: expect.stringContaining('桌面端登录') }),
      ]))
    } finally {
      await runtime.dispose()
    }
  })
})
