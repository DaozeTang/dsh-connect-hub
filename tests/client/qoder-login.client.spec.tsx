// @vitest-environment jsdom
/**
 * Qoder login-block tests: automatic import from the desktop app, the manual
 * PAT fallback, clearing the hub's copy, and the locale copy that makes the
 * current mode obvious. The design-system atoms are mocked to semantic DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const React = await import('react')
  function h(tag: string, props: Record<string, unknown>, ...children: ReactNode[]): ReactElement {
    return React.createElement(tag, props as unknown as React.HTMLAttributes<HTMLElement>, ...children)
  }
  return {
    Button: ({ icon, children, type, ...rest }: Record<string, unknown>) =>
      h('button', { type: typeof type === 'string' ? type : 'button', ...rest }, icon as ReactNode, children as ReactNode),
    Switch: ({ checked, onChange, label, disabled }: Record<string, unknown>) =>
      h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        disabled,
        onClick: () => { (onChange as (next: boolean) => void)(!(checked as boolean)) },
      }),
    SegmentedControl: ({ value, options, onChange, label }: Record<string, unknown>) =>
      h('div', { role: 'tablist', 'aria-label': label }, ...(options as { value: string; label: string }[]).map((option) =>
        h('button', {
          key: option.value,
          type: 'button',
          role: 'tab',
          'aria-selected': option.value === value,
          onClick: () => { (onChange as (next: string) => void)(option.value) },
        }, option.label))),
    Input: ({ icon, className, ...rest }: Record<string, unknown>) =>
      h('span', { className }, icon as ReactNode, h('input', rest)),
    Tag: ({ children, tone }: Record<string, unknown>) => h('span', { 'data-tone': tone }, children as ReactNode),
    Tooltip: ({ children }: Record<string, unknown>) => children as ReactElement,
    StateDot: ({ state }: Record<string, unknown>) => h('span', { 'data-state': state }),
    Modal: ({ open, title, description, children, footer }: Record<string, unknown>) =>
      (open
        ? h(
          'div',
          { role: 'dialog', 'aria-label': title },
          description as ReactNode,
          children as ReactNode,
          footer as ReactNode,
        )
        : null),
    useAnchoredPosition: () => ({ left: 10, top: 10 }),
    useDismissOnOutsidePointer: () => {},
  }
})

import { HubSettingsPage } from '../../src/client/HubSettingsPage.tsx'
import type { ConnectHubTranslate } from '../../src/client/format.ts'
import { en, zh } from '../../src/client/locales.ts'
import type { ConnectHubKey } from '../../src/client/locales.ts'
import { clientPreferences } from '../../src/client/prefs.ts'
import type { HubAction, HubStatus, ProviderStatus } from '../../src/shared/contracts.ts'
import {
  DAY,
  HOUR,
  NOW,
  buildAllProviders,
  buildCredential,
  buildHubStatus,
  buildProvider,
  buildQoderAppLogin,
  buildWarning,
} from './fixtures.ts'

type ActionReply =
  | { ok: true; message?: string; data?: unknown; status: HubStatus }
  | { ok: false; error: string; detail?: string }

const CAPABILITIES: ProviderStatus['capabilities'] = {
  usage: true,
  checkin: true,
  transfer: false,
  probes: false,
  multiAccount: false,
}

function makeT(locale: 'zh' | 'en' = 'zh'): ConnectHubTranslate {
  const dictionary: Record<string, string> = locale === 'zh' ? zh : en
  return ((key: ConnectHubKey, params?: Record<string, unknown>) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])))
  }) as ConnectHubTranslate
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

let currentStatus: HubStatus
let actionReply: ((action: HubAction) => ActionReply | Promise<ActionReply>) | null = null
let dispatched: HubAction[] = []

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/status')) return json(currentStatus)
    if (url.endsWith('/action')) {
      const action = JSON.parse(String(init?.body)) as HubAction
      dispatched.push(action)
      const reply = actionReply === null
        ? { ok: true as const, status: currentStatus }
        : await actionReply(action)
      if (reply.ok) currentStatus = reply.status
      return json(reply)
    }
    throw new Error(`unexpected fetch: ${url}`)
  }))
}

function setup(status: HubStatus, reply?: (action: HubAction) => ActionReply | Promise<ActionReply>): void {
  currentStatus = status
  actionReply = reply ?? null
  installFetch()
}

function renderPage(locale: 'zh' | 'en' = 'zh'): void {
  render(<HubSettingsPage t={makeT(locale)} />)
}

/** A Qoder route with no credential: desktop import is the recommended path. */
function needsCredentialQoder(): ProviderStatus {
  return buildProvider('qoder', { capabilities: CAPABILITIES })
}

beforeEach(() => {
  dispatched = []
  actionReply = null
  clientPreferences.setSeat('toolbar')
  clientPreferences.setFamily('qoder')
  clientPreferences.setRegion('cn')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('desktop login import', () => {
  it('offers auto-import as the primary action, with the PAT entry collapsed but reachable', async () => {
    setup(buildHubStatus([needsCredentialQoder()]))
    renderPage()
    expect(await screen.findByText(zh.desktopSignInMissing.replaceAll('{app}', 'Qoder'))).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.qoderLoginImport })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.qoderLoginTogglePat })).toBeTruthy()
    expect(screen.queryByPlaceholderText(zh.qoderPatPlaceholder)).toBeNull()
    expect(screen.queryByRole('button', { name: zh.qoderPatClear })).toBeNull()
  })

  it('imports the desktop sign-in, then shows the app badge, account and expiry', async () => {
    const appStatus = buildHubStatus([buildQoderAppLogin()])
    setup(
      buildHubStatus([needsCredentialQoder()]),
      () => ({ ok: true, status: appStatus, message: '已从 Qoder 桌面端读取登录' }),
    )
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: zh.qoderLoginImport }))
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'import-desktop-login', provider: 'qoder' })
    })
    expect(await screen.findByText(zh.sourceApp)).toBeTruthy()
    // The account is the identity line; the badge above already names the mode.
    expect(screen.getByText('Qoder 用户')).toBeTruthy()
    expect(screen.getByText(zh.desktopSignInHint.replaceAll('{app}', 'Qoder'))).toBeTruthy()
    expect(screen.getByText('已从 Qoder 桌面端读取登录')).toBeTruthy()
    // One masked fact under the identity, not a second credential box.
    expect(screen.getByText(zh.credentialLabel)).toBeTruthy()
    expect(screen.getByText('****9f2c')).toBeTruthy()
    expect(screen.getByText(zh.accountExpires)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.refreshAccount })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.qoderPatClear })).toBeTruthy()
  })

  it('confirms before replacing a manually saved PAT with the desktop sign-in', async () => {
    const patStatus = buildHubStatus([buildProvider('qoder', {
      state: 'ready',
      credential: buildCredential(),
      capabilities: CAPABILITIES,
    })])
    setup(patStatus)
    renderPage()
    expect(await screen.findByText(zh.qoderLoginPatTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.qoderLoginImport }))
    const dialog = await screen.findByRole('dialog', { name: zh.qoderLoginReplacePatTitle })
    expect(within(dialog).getByText(zh.qoderLoginReplacePatBody)).toBeTruthy()
    expect(dispatched).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: zh.qoderLoginSwitch }))
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'import-desktop-login', provider: 'qoder' })
    })
  })

  it('shows the in-flight label and keeps the button disabled during the action', async () => {
    let resolveAction: ((reply: ActionReply) => void) | undefined
    setup(buildHubStatus([needsCredentialQoder()]))
    actionReply = () => new Promise<ActionReply>((resolve) => { resolveAction = resolve })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: zh.qoderLoginImport }))
    const inflight = await screen.findByRole('button', { name: zh.refreshAccountBusy })
    expect(inflight.hasAttribute('disabled')).toBe(true)
    resolveAction?.({ ok: true, status: buildHubStatus([buildQoderAppLogin()]) })
    expect(await screen.findByRole('button', { name: zh.refreshAccount })).toBeTruthy()
  })

  it('surfaces a rejected import with the host detail, keeping both options available', async () => {
    const detail = '未找到 Qoder 桌面端登录，请先在本机登录一次'
    setup(
      buildHubStatus([needsCredentialQoder()]),
      () => ({ ok: false, error: 'action_failed', detail }),
    )
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: zh.qoderLoginImport }))
    expect(await screen.findByText(detail)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.qoderLoginImport })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.qoderLoginTogglePat })).toBeTruthy()
  })

  it('warns when the imported app login has expired and offers a re-read', async () => {
    const expired = buildQoderAppLogin({
      state: 'error',
      credential: {
        source: 'app',
        writable: false,
        masked: '****9f2c',
        expiresAt: NOW - HOUR,
        refreshExpiresAt: NOW + 20 * DAY,
      },
      warnings: [buildWarning({ code: 'refresh-expired', level: 'error', message: '登录状态已过期' })],
    })
    setup(buildHubStatus([expired]))
    renderPage()
    expect(await screen.findByText(zh.qoderLoginStale)).toBeTruthy()
    expect(screen.queryByText(zh.desktopSignInHint.replaceAll('{app}', 'Qoder'))).toBeNull()
    expect(screen.getByRole('button', { name: zh.refreshAccount })).toBeTruthy()
  })

  it('warns when the host reports a rejected desktop sign-in', async () => {
    setup(buildHubStatus([buildQoderAppLogin({
      state: 'error',
      warnings: [{ code: 'desktop-credential-rejected', level: 'error', message: 'host sentence' }],
    })]))
    renderPage()
    expect(await screen.findByText(zh.qoderLoginStale)).toBeTruthy()
    expect(screen.getByText(zh.warningDesktopCredentialRejected)).toBeTruthy()
  })
})

describe('manual PAT fallback', () => {
  it('starts open when the PAT is the current mode and says so', async () => {
    // A saved PAT has no desktop account, so the identity is the PAT itself.
    setup(buildHubStatus([buildProvider('qoder', {
      state: 'ready',
      credential: buildCredential(),
      capabilities: CAPABILITIES,
    })]))
    renderPage()
    expect(await screen.findByText(zh.qoderLoginPatTitle)).toBeTruthy()
    expect(screen.getByText('****abcd')).toBeTruthy()
    expect(screen.getByText(zh.qoderLoginPatHint)).toBeTruthy()
    expect(screen.getByPlaceholderText(zh.qoderPatPlaceholder)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.qoderLoginHidePat })).toBeTruthy()
  })

  it('switches an app login to PAT mode by saving a PAT (input is not disabled)', async () => {
    const appStatus = buildHubStatus([buildQoderAppLogin()])
    const patStatus = buildHubStatus([buildProvider('qoder', {
      state: 'ready',
      credential: buildCredential(),
      capabilities: CAPABILITIES,
    })])
    setup(appStatus, (action) => action.type === 'save-secret'
      ? { ok: true, status: patStatus }
      : { ok: true, status: appStatus })
    renderPage()
    expect(await screen.findByText(zh.sourceApp)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.qoderLoginTogglePat }))
    const input = await screen.findByPlaceholderText(zh.qoderPatPlaceholder) as HTMLInputElement
    expect(input.hasAttribute('disabled')).toBe(false)
    fireEvent.change(input, { target: { value: 'pat-123' } })
    fireEvent.click(screen.getByRole('button', { name: zh.qoderPatSave }))
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'save-secret', provider: 'qoder', secret: 'pat-123' })
    })
    expect(await screen.findByText(zh.qoderLoginPatTitle)).toBeTruthy()
    expect(screen.getByText(zh.qoderPatSaved)).toBeTruthy()
    expect(input.value).toBe('')
  })

  it('keeps a rejected PAT entry open with its error and the draft', async () => {
    const detail = 'PAT 无效或已过期'
    setup(
      buildHubStatus([buildQoderAppLogin()]),
      () => ({ ok: false, error: 'action_failed', detail }),
    )
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: zh.qoderLoginTogglePat }))
    const input = await screen.findByPlaceholderText(zh.qoderPatPlaceholder) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: zh.qoderPatSave }))
    expect(await screen.findByText(detail)).toBeTruthy()
    expect(screen.getByPlaceholderText(zh.qoderPatPlaceholder)).toBeTruthy()
    expect(input.value).toBe('bad')
  })
})

describe('credential provenance', () => {
  it('states the provider name once and keeps a family monogram when a PAT has no account', async () => {
    setup(buildHubStatus([buildProvider('qoder', {
      state: 'ready',
      credential: buildCredential(),
      capabilities: CAPABILITIES,
    })]))
    renderPage()
    expect(await screen.findByText(zh.qoderLoginPatTitle)).toBeTruthy()
    // The hub tab and the card header each name the route; the identity does not.
    expect(screen.getAllByText('Qoder')).toHaveLength(2)
    // The source tag is rendered even without an account row.
    expect(screen.getAllByText(zh.qoderLoginPatBadge)).toHaveLength(1)
    // No account name: the monogram falls back to the family initial, not "插".
    expect(screen.getByText('Q')).toBeTruthy()
  })

  it('labels an environment credential as such instead of as a manual PAT', async () => {
    setup(buildHubStatus([buildProvider('qoder', {
      state: 'ready',
      credential: { source: 'env', writable: false, masked: '****env1' },
      capabilities: CAPABILITIES,
    })]))
    renderPage()
    expect(await screen.findByText(zh.qoderLoginEnvHint)).toBeTruthy()
    expect(screen.getAllByText(zh.sourceEnv).length).toBeGreaterThan(0)
    expect(screen.queryByText(zh.qoderLoginPatBadge)).toBeNull()
    expect(screen.queryByPlaceholderText(zh.qoderPatPlaceholder)).toBeNull()
  })
})

describe('clearing the hub copy', () => {
  it('allows clearing an imported app login and leaves the import path open', async () => {
    const cleared = buildHubStatus([needsCredentialQoder()])
    setup(
      buildHubStatus([buildQoderAppLogin()]),
      (action) => action.type === 'clear-secret' ? { ok: true, status: cleared } : { ok: true, status: currentStatus },
    )
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: zh.qoderPatClear }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe(zh.qoderPatClearTitle.replace('{provider}', 'Qoder'))
    expect(within(dialog).getByText(zh.qoderPatClearBody)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: zh.qoderPatClear }))
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'clear-secret', provider: 'qoder' })
    })
    expect(await screen.findByText(zh.qoderPatCleared)).toBeTruthy()
    expect(screen.getByText(zh.desktopSignInMissing.replaceAll('{app}', 'Qoder'))).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.qoderLoginImport })).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.qoderPatClear })).toBeNull()
  })
})

describe('provider switching', () => {
  it('drops a PAT draft when the region switch replaces the provider', async () => {
    setup(buildHubStatus(buildAllProviders()))
    renderPage()
    const input = await screen.findByPlaceholderText(zh.qoderPatPlaceholder) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'draft-pat' } })
    expect(input.value).toBe('draft-pat')
    fireEvent.click(screen.getByRole('tab', { name: zh.regionGlobal }))
    await waitFor(() => { expect(screen.queryByPlaceholderText(zh.qoderPatPlaceholder)).toBeNull() })
    fireEvent.click(screen.getByRole('tab', { name: zh.regionCn }))
    const reopened = await screen.findByPlaceholderText(zh.qoderPatPlaceholder) as HTMLInputElement
    expect(reopened.value).toBe('')
  })
})

describe('english copy', () => {
  it('localizes the auto-import state and the collapsed PAT entry', async () => {
    setup(buildHubStatus([buildQoderAppLogin()]))
    renderPage('en')
    expect(await screen.findByText(en.sourceApp)).toBeTruthy()
    expect(screen.getByText('Qoder 用户')).toBeTruthy()
    expect(screen.getByText(en.desktopSignInHint.replaceAll('{app}', 'Qoder'))).toBeTruthy()
    expect(screen.getByRole('button', { name: en.refreshAccount })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.qoderLoginTogglePat }))
    expect(await screen.findByPlaceholderText(en.qoderPatPlaceholder)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.qoderPatSave })).toBeTruthy()
    expect(screen.getByText(en.qoderPatHint)).toBeTruthy()
  })

  it('localizes the manual PAT state', async () => {
    setup(buildHubStatus([buildProvider('qoder', {
      state: 'ready',
      credential: buildCredential(),
      capabilities: CAPABILITIES,
    })]))
    renderPage('en')
    expect(await screen.findByText(en.qoderLoginPatTitle)).toBeTruthy()
    expect(screen.getByText(en.qoderLoginPatHint)).toBeTruthy()
    expect(screen.getByPlaceholderText(en.qoderPatPlaceholder)).toBeTruthy()
  })
})
