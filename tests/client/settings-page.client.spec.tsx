// @vitest-environment jsdom
/**
 * Settings-page render tests. The design-system atoms are mocked down to
 * semantic DOM so the tests assert OUR composition (roles, labels, dispatch
 * payloads, reconciliation) without booting the full shell bundle.
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
    Switch: ({ checked, onChange, label, disabled, title }: Record<string, unknown>) =>
      h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        disabled,
        title,
        onClick: () => { (onChange as (next: boolean) => void)(!(checked as boolean)) },
      }),
    SegmentedControl: ({ id, value, options, onChange, label }: Record<string, unknown>) =>
      h('div', { role: 'tablist', 'aria-label': label }, ...(options as { value: string; label: string }[]).map((option) =>
        h('button', {
          key: option.value,
          id: `${String(id)}-${option.value}`,
          type: 'button',
          role: 'tab',
          'aria-selected': option.value === value,
          'aria-controls': `${String(id)}-${option.value}-panel`,
          onClick: () => { (onChange as (next: string) => void)(option.value) },
        }, option.label))),
    Input: ({ icon, className, ...rest }: Record<string, unknown>) =>
      h('span', { className }, icon as ReactNode, h('input', rest)),
    Tag: ({ children, tone }: Record<string, unknown>) => h('span', { 'data-tone': tone }, children as ReactNode),
    Tooltip: ({ children }: Record<string, unknown>) => children as ReactElement,
    StateDot: ({ state }: Record<string, unknown>) => h('span', { 'data-state': state }),
    Modal: ({ open, title, children, footer }: Record<string, unknown>) =>
      (open ? h('div', { role: 'dialog', 'aria-label': title }, children as ReactNode, footer as ReactNode) : null),
    useAnchoredPosition: () => ({ left: 10, top: 10 }),
    useDismissOnOutsidePointer: () => {},
  }
})

import { HubSettingsPage } from '../../src/client/HubSettingsPage.tsx'
import type { ConnectHubTranslate } from '../../src/client/format.ts'
import { en, zh } from '../../src/client/locales.ts'
import type { ConnectHubKey } from '../../src/client/locales.ts'
import { clientPreferences } from '../../src/client/prefs.ts'
import type { HubAction, HubStatus } from '../../src/shared/contracts.ts'
import {
  DAY,
  NOW,
  buildAccount,
  buildAllProviders,
  buildHubStatus,
  buildCheckin,
  buildCredits,
  buildLogRow,
  buildModel,
  buildProvider,
  buildQoderAppLogin,
  buildQoderReady,
  buildTraeReady,
  buildWarning,
  buildWorkBuddyReady,
} from './fixtures.ts'

type ActionReply =
  | { ok: true; message?: string; data?: unknown; status: HubStatus }
  | { ok: false; error: string; detail?: string }

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

function renderPage(): void {
  render(<HubSettingsPage t={makeT('zh')} />)
}

/** The PAT entry is a secondary toggle; open it before driving its form. */
async function openPatForm(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: zh.qoderLoginTogglePat }))
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

describe('HubSettingsPage states', () => {
  it('renders an honest empty state when no provider is reported, and refreshes', async () => {
    setup(
      buildHubStatus([]),
      () => ({ ok: true, status: buildHubStatus([buildQoderReady()]) }),
    )
    renderPage()
    expect(await screen.findByText(zh.emptyTitle)).toBeTruthy()
    expect(screen.getByText(zh.emptyBody)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.refreshNow }))
    await waitFor(() => { expect(dispatched).toContainEqual({ type: 'refresh-status' }) })
    expect(await screen.findByText('Qwen3 Coder')).toBeTruthy()
  })

  it('shows the retry state when the first status read fails', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(json(buildHubStatus([buildQoderReady()])))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()
    expect(await screen.findByText(zh.loadErrorTitle)).toBeTruthy()
    expect(screen.getByText(`${zh.loadErrorBody.replace('{message}', 'network down')}`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(await screen.findByText('Qwen3 Coder')).toBeTruthy()
  })

  it('shows the needs-credential PAT form and stores a verified PAT', async () => {
    const needsCredential = buildProvider('qoder', {
      capabilities: { usage: true, checkin: true, transfer: false, probes: false, multiAccount: false },
    })
    const ready = buildQoderReady()
    setup(buildHubStatus([needsCredential]), () => ({ ok: true, status: buildHubStatus([ready]) }))
    renderPage()
    await openPatForm()
    const input = await screen.findByPlaceholderText(zh.qoderPatPlaceholder) as HTMLInputElement
    const save = screen.getByRole('button', { name: zh.qoderPatSave })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.change(input, { target: { value: 'pat-123' } })
    expect(save.hasAttribute('disabled')).toBe(false)
    fireEvent.click(save)
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'save-secret', provider: 'qoder', secret: 'pat-123' })
    })
    expect(await screen.findByText(zh.qoderPatSaved)).toBeTruthy()
    expect(input.value).toBe('')
    expect((await screen.findAllByText(zh.stateReady)).length).toBeGreaterThan(0)
  })

  it('reports a rejected PAT honestly and keeps the draft', async () => {
    setup(
      buildHubStatus([buildProvider('qoder')]),
      () => ({ ok: false, error: 'action_failed', detail: 'PAT 无效或已过期' }),
    )
    renderPage()
    await openPatForm()
    const input = await screen.findByPlaceholderText(zh.qoderPatPlaceholder)
    fireEvent.change(input, { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: zh.qoderPatSave }))
    expect(await screen.findByText('PAT 无效或已过期')).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('bad')
  })

  it('renders provider warnings and known plan labels through the English dictionary', async () => {
    const provider = buildQoderReady({
      warnings: [buildWarning({ code: 'credits-error', level: 'warn', message: '额度读取失败：billing offline' })],
      credits: buildCredits({ kind: 'subscription', remaining: 320, total: 500, plan: '不限额度' }),
    })
    setup(buildHubStatus([provider]))
    render(<HubSettingsPage t={makeT('en')} />)
    expect(await screen.findByText(en.warningCreditsError)).toBeTruthy()
    expect(screen.queryByText('额度读取失败：billing offline')).toBeNull()
    expect(await screen.findByText(en.planUnlimited)).toBeTruthy()
    expect(screen.queryByText('不限额度')).toBeNull()
  })

  it('validates an empty PAT submitted through the form', async () => {
    setup(buildHubStatus([buildProvider('qoder')]))
    renderPage()
    await openPatForm()
    const input = await screen.findByPlaceholderText(zh.qoderPatPlaceholder)
    const form = input.closest('form')
    expect(form).not.toBeNull()
    if (form !== null) fireEvent.submit(form)
    expect(await screen.findByText(zh.qoderPatEmpty)).toBeTruthy()
    expect(dispatched).toHaveLength(0)
  })

  it('shows a hub-level warning banner and lets the user dismiss it', async () => {
    const status = buildHubStatus([buildQoderReady()], {
      warnings: [buildWarning({ code: 'pi-ai-version', level: 'warn', message: 'pi-ai 版本不匹配', at: NOW })],
    })
    setup(status)
    renderPage()
    expect(await screen.findByText('pi-ai 版本不匹配')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    await waitFor(() => { expect(screen.queryByText('pi-ai 版本不匹配')).toBeNull() })
  })
})

describe('models section', () => {
  it('renders catalog data, filters with search, and flags unknown prices', async () => {
    setup(buildHubStatus([buildQoderReady()]))
    renderPage()
    expect(await screen.findByText('Qwen3 Coder')).toBeTruthy()
    expect(screen.getByText(zh.modelsCount.replace('{enabled}', '2').replace('{total}', '3'))).toBeTruthy()
    expect(screen.getByText(zh.priceUnknown)).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'max' } })
    expect(screen.queryByText('Qwen3 Coder')).toBeNull()
    expect(screen.getByText('Qwen3 Max')).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } })
    expect(screen.getByText(zh.modelsNoResults.replace('{query}', 'zzz'))).toBeTruthy()
  })

  it('applies a model toggle optimistically and reconciles with the returned status', async () => {
    setup(buildHubStatus([buildQoderReady()]))
    let resolveAction: ((reply: ActionReply) => void) | undefined
    actionReply = () => new Promise<ActionReply>((resolve) => { resolveAction = resolve })
    renderPage()
    const toggle = await screen.findByRole('switch', { name: zh.modelEnableAria.replace('{model}', 'Qwen3 Max') })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(dispatched).toContainEqual({ type: 'set-model-enabled', provider: 'qoder', modelId: 'qwen3-max', enabled: true })
    // The host answers with the same (disabled) state: the optimistic edit reverts.
    resolveAction?.({ ok: true, status: buildHubStatus([buildQoderReady()]) })
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: zh.modelEnableAria.replace('{model}', 'Qwen3 Max') }).getAttribute('aria-checked')).toBe('false')
    })
  })

  it('sends bulk enable/disable and max-context actions', async () => {
    setup(buildHubStatus([buildQoderReady()]))
    renderPage()
    await screen.findByText('Qwen3 Coder')
    fireEvent.click(screen.getByRole('button', { name: zh.disableAll }))
    await waitFor(() => {
      expect(dispatched).toContainEqual({
        type: 'set-models-enabled',
        provider: 'qoder',
        modelIds: ['qwen3-coder', 'qwen3-max', 'qwen2.5-vl'],
        enabled: false,
      })
    })
    fireEvent.click(screen.getByRole('switch', { name: zh.maxContext }))
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'set-max-context', provider: 'qoder', useMax: true })
    })
  })

  it('dispatches the providerless global refresh from the header', async () => {
    setup(buildHubStatus([buildQoderReady()]))
    renderPage()
    await screen.findByText('Qwen3 Coder')
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(dispatched).toContainEqual({ type: 'refresh-status' }) })
  })

  it('refreshes the catalog with its own action', async () => {
    setup(buildHubStatus([buildQoderReady()]))
    renderPage()
    await screen.findByText('Qwen3 Coder')
    fireEvent.click(screen.getByRole('button', { name: zh.refreshCatalog }))
    await waitFor(() => { expect(dispatched).toContainEqual({ type: 'refresh-catalog', provider: 'qoder' }) })
  })

  it('renders a stale-identity catalog discard as a failure, never success', async () => {
    const detail = '账号已切换，已丢弃过期的模型目录结果'
    setup(
      buildHubStatus([buildQoderReady()]),
      () => ({ ok: false, error: 'stale_identity', detail }),
    )
    renderPage()
    await screen.findByText('Qwen3 Coder')
    fireEvent.click(screen.getByRole('button', { name: zh.refreshCatalog }))
    expect(await screen.findByText(detail)).toBeTruthy()
    // The green "updated N models" wording must not be shown for a result the
    // host discarded because the account changed.
    expect(screen.queryByText(/模型目录已更新/)).toBeNull()
  })
})

describe('check-in section', () => {
  it('dispatches manual check-in, schedule changes and log clearing', async () => {
    setup(buildHubStatus([buildQoderReady({ checkin: buildCheckin({ state: 'available', log: [buildLogRow()] }) })]))
    renderPage()
    await screen.findByText(zh.sectionCheckin)
    fireEvent.click(screen.getByRole('button', { name: zh.checkinNow }))
    await waitFor(() => { expect(dispatched).toContainEqual({ type: 'checkin', provider: 'qoder' }) })

    fireEvent.click(screen.getByRole('switch', { name: zh.checkinAuto }))
    await waitFor(() => { expect(dispatched).toContainEqual({ type: 'set-checkin', provider: 'qoder', enabled: false }) })

    const timeInput = screen.getByLabelText(zh.checkinTimeLabel) as HTMLInputElement
    fireEvent.change(timeInput, { target: { value: '12:30' } })
    fireEvent.submit(timeInput.closest('form') as HTMLFormElement)
    await waitFor(() => { expect(dispatched).toContainEqual({ type: 'set-checkin', provider: 'qoder', minute: 750 }) })

    fireEvent.click(screen.getByRole('button', { name: zh.checkinClearLog }))
    await waitFor(() => { expect(dispatched).toContainEqual({ type: 'clear-checkin-log', provider: 'qoder' }) })
  })

  it('rejects an invalid time locally without dispatching', async () => {
    setup(buildHubStatus([buildQoderReady()]))
    renderPage()
    await screen.findByText(zh.sectionCheckin)
    const timeInput = screen.getByLabelText(zh.checkinTimeLabel)
    fireEvent.change(timeInput, { target: { value: '' } })
    fireEvent.submit(timeInput.closest('form') as HTMLFormElement)
    expect(await screen.findByText(zh.checkinTimeInvalid)).toBeTruthy()
    expect(dispatched.filter((action) => action.type === 'set-checkin')).toHaveLength(0)
  })
})

describe('family switching, probes and transfer', () => {
  it('switches to WorkBuddy: usage and probes render, check-in does not', async () => {
    setup(buildHubStatus(buildAllProviders()))
    renderPage()
    await screen.findByText('Qwen3 Coder')
    fireEvent.click(screen.getByRole('button', { name: /WorkBuddy/ }))
    expect((await screen.findAllByText('WorkBuddy Pro')).length).toBeGreaterThan(0)
    expect(screen.getByText(zh.sectionProbes)).toBeTruthy()
    expect(screen.queryByText(zh.sectionCheckin)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.probeModelAria.replace('{model}', 'WorkBuddy Pro') }))
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'probe-model', provider: 'workbuddy', modelId: 'wb-pro' })
    })
    fireEvent.click(screen.getByRole('switch', { name: zh.probeConsent }))
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'set-probe-consent', provider: 'workbuddy', consent: false })
    })
  })

  it('shows the WorkBuddy check-in card only while the activity is available', async () => {
    const capabilities = { usage: true, checkin: true, transfer: false, probes: true, multiAccount: false }
    setup(buildHubStatus([buildWorkBuddyReady({ capabilities, checkin: buildCheckin() })]))
    renderPage()
    fireEvent.click(within(await screen.findByRole('group', { name: zh.familyAria })).getByRole('button', { name: /WorkBuddy/ }))
    expect(await screen.findByText(zh.sectionCheckin)).toBeTruthy()
    cleanup()
    setup(buildHubStatus([buildWorkBuddyReady({ capabilities, checkin: buildCheckin({ supported: false, state: 'unknown' }) })]))
    renderPage()
    fireEvent.click(within(await screen.findByRole('group', { name: zh.familyAria })).getByRole('button', { name: /WorkBuddy/ }))
    await screen.findByText('WorkBuddy 用户')
    expect(screen.queryByText(zh.sectionCheckin)).toBeNull()
  })

  it('selects Trae accounts and runs the transfer flow with a redacted preview', async () => {
    setup(
      buildHubStatus([buildTraeReady()]),
      (action) => {
        if (action.type === 'transfer-preview') {
          return {
            ok: true,
            status: currentStatus,
            data: { rows: [{ id: 'trae-c', label: 'carol@example.com', region: 'cn', hasToken: true }], skipped: 2 },
          }
        }
        if (action.type === 'transfer-export') {
          return { ok: true, status: currentStatus, data: { fileName: 'trae-accounts.json', content: '{"accounts":[]}' } }
        }
        return { ok: true, status: currentStatus }
      },
    )
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Trae/ }))
    const radio = await screen.findByRole('radio', { name: zh.accountSelectAria.replace('{account}', 'bob@example.com') })
    fireEvent.click(radio)
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'select-account', provider: 'trae', accountId: 'trae-b' })
    })

    fireEvent.click(screen.getByRole('button', { name: zh.transferExport }))
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'transfer-export', provider: 'trae', accountIds: ['trae-a', 'trae-b'] })
    })
    expect(await screen.findByText(zh.transferExported.replace('{fileName}', 'trae-accounts.json'))).toBeTruthy()

    fireEvent.change(screen.getByLabelText(zh.transferImportTitle), { target: { value: '{"accounts":[]}' } })
    fireEvent.click(screen.getByRole('button', { name: zh.transferPreview }))
    expect(await screen.findByText(zh.transferPreviewSummary.replace('{count}', '1').replace('{skipped}', '2'))).toBeTruthy()
    expect(screen.getByText('carol@example.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.transferImport }))
    await waitFor(() => {
      expect(dispatched).toContainEqual({
        type: 'transfer-import',
        provider: 'trae',
        text: '{"accounts":[]}',
        accountIds: ['trae-c'],
      })
    })
  })

  it('keeps the account table honest about expired sign-ins', async () => {
    setup(buildHubStatus([buildTraeReady()]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Trae/ }))
    expect((await screen.findAllByText(zh.expiredTag)).length).toBeGreaterThan(0)
  })

  it('labels the Trae app-sign-in copy as auto-refreshed', async () => {
    setup(buildHubStatus([buildTraeReady()]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Trae/ }))
    expect(await screen.findByText(zh.sourceAppRefreshed)).toBeTruthy()
  })
})

describe('composer seat preference', () => {
  it('persists the chosen seat through the browser-local store', async () => {
    setup(buildHubStatus([buildQoderReady()]))
    renderPage()
    await screen.findByText(zh.sectionPreferences)
    fireEvent.click(screen.getByRole('tab', { name: zh.composerSeatDock }))
    expect(clientPreferences.get().seat).toBe('dock')
  })
})

describe('workbuddy account block', () => {
  it('shows the app sign-in badge, the account and its credential facts once', async () => {
    const workbuddy = buildWorkBuddyReady({
      credential: { source: 'app', writable: false, masked: '****abcd', expiresAt: NOW + DAY, refreshExpiresAt: NOW + 40 * DAY },
    })
    setup(buildHubStatus([workbuddy]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /WorkBuddy/ }))
    expect((await screen.findAllByText(zh.sourceApp)).length).toBeGreaterThan(0)
    expect(screen.getByText('WorkBuddy 用户')).toBeTruthy()
    expect(screen.getByText('****abcd')).toBeTruthy()
    expect(screen.getByText(zh.desktopSignInHint.replaceAll('{app}', 'WorkBuddy'))).toBeTruthy()
    // Re-reading is the only credential action: no PAT form, no clear button.
    expect(screen.getByRole('button', { name: zh.refreshAccount })).toBeTruthy()
    expect(screen.queryByPlaceholderText(zh.qoderPatPlaceholder)).toBeNull()
    expect(screen.queryByRole('button', { name: zh.qoderPatClear })).toBeNull()
    expect(screen.queryByText(zh.sourceAppRefreshed)).toBeNull()
  })

  it('does not offer the unsupported CN max-context switch', async () => {
    setup(buildHubStatus([buildWorkBuddyReady()]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /WorkBuddy/ }))
    await screen.findAllByText('WorkBuddy Pro')
    expect(screen.queryByRole('switch', { name: zh.maxContext })).toBeNull()
  })

  it('shows the enterprise badge for an enterprise sign-in', async () => {
    const workbuddy = buildWorkBuddyReady({
      account: { label: 'WorkBuddy 用户', detail: 'Enterprise plan', enterprise: true },
    })
    setup(buildHubStatus([workbuddy]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /WorkBuddy/ }))
    expect(await screen.findByText(zh.accountEnterprise)).toBeTruthy()
  })

  it('re-reads the desktop sign-in', async () => {
    setup(buildHubStatus([buildWorkBuddyReady()]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /WorkBuddy/ }))
    fireEvent.click(await screen.findByRole('button', { name: zh.refreshAccount }))
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'refresh-account', provider: 'workbuddy' })
    })
  })
})

describe('unified connection layout', () => {
  it('keeps one family switcher and one region switch', async () => {
    setup(buildHubStatus(buildAllProviders()))
    renderPage()
    await screen.findByText('Qwen3 Coder')
    // Family chips are the only family navigation; the removed segmented
    // control must not come back as a second tablist with the same name.
    expect(screen.queryByRole('tablist', { name: zh.familyAria })).toBeNull()
    expect(screen.getByRole('group', { name: zh.familyAria })).toBeTruthy()
    expect(screen.getAllByRole('tablist', { name: zh.regionAria })).toHaveLength(1)
  })

  it('renders the same identity, actions and hint structure for all three families', async () => {
    setup(buildHubStatus(buildAllProviders()))
    renderPage()
    await screen.findByText('Qwen3 Coder')
    const connectionCard = (): HTMLElement => {
      const heading = screen.getByText(zh.sectionConnection)
      const section = heading.closest('section')
      expect(section).not.toBeNull()
      return section as HTMLElement
    }
    // Qoder (PAT mode): account identity, one action row, one hint.
    expect(within(connectionCard()).getByText('alice@example.com')).toBeTruthy()
    expect(within(connectionCard()).getByRole('button', { name: zh.qoderLoginImport })).toBeTruthy()
    expect(connectionCard().querySelector('.ch-conn')).not.toBeNull()
    expect(connectionCard().querySelector('.ch-actions')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /WorkBuddy/ }))
    await screen.findByText('WorkBuddy 用户')
    expect(within(connectionCard()).getByRole('button', { name: zh.refreshAccount })).toBeTruthy()
    expect(connectionCard().querySelector('.ch-id')).not.toBeNull()
    expect(connectionCard().querySelector('.ch-conn')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Trae/ }))
    await screen.findByRole('radio', { name: zh.accountSelectAria.replace('{account}', 'alice@example.com') })
    expect(connectionCard().querySelector('.ch-accounts')).not.toBeNull()
    expect(within(connectionCard()).getByRole('button', { name: zh.refreshAccounts })).toBeTruthy()
  })

  it('states the Qoder account, source and credential facts exactly once', async () => {
    setup(buildHubStatus([buildQoderAppLogin()]))
    renderPage()
    expect(await screen.findAllByText('Qoder 用户')).toHaveLength(1)
    expect(screen.getAllByText(zh.sourceApp)).toHaveLength(1)
    expect(screen.getAllByText(zh.credentialLabel)).toHaveLength(1)
    expect(screen.getAllByText('****9f2c')).toHaveLength(1)
  })

  it('keeps per-account check-in in the check-in card only', async () => {
    setup(buildHubStatus([buildTraeReady()]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Trae/ }))
    await screen.findByRole('radio', { name: zh.accountSelectAria.replace('{account}', 'alice@example.com') })
    // Two accounts, two per-account buttons; no extra global button and no
    // duplicate check-in action inside the connection card.
    expect(screen.getAllByRole('button', { name: /立即签到/ })).toHaveLength(2)
  })

  it('offers one global check-in action for a single-account provider', async () => {
    setup(buildHubStatus([buildQoderReady()]))
    renderPage()
    await screen.findByText('alice@example.com')
    expect(screen.getAllByRole('button', { name: zh.checkinNow })).toHaveLength(1)
  })

  it('selects a Trae account by clicking anywhere in its row', async () => {
    setup(buildHubStatus([buildTraeReady()]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Trae/ }))
    const radio = await screen.findByRole('radio', { name: zh.accountSelectAria.replace('{account}', 'bob@example.com') })
    const row = radio.closest('label')
    expect(row).not.toBeNull()
    fireEvent.click(within(row as HTMLElement).getByText('bob@example.com'))
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'select-account', provider: 'trae', accountId: 'trae-b' })
    })
  })

  it('links the active region tab to the rendered panel', async () => {
    setup(buildHubStatus(buildAllProviders()))
    renderPage()
    await screen.findByText('Qwen3 Coder')
    const tab = screen.getByRole('tab', { name: zh.regionCn })
    const controls = tab.getAttribute('aria-controls')
    expect(controls).toBe('ch-region-cn-panel')
    expect(document.getElementById(controls as string)).not.toBeNull()
    expect(document.getElementById(controls as string)?.getAttribute('role')).toBe('tabpanel')
    const other = screen.getByRole('tab', { name: zh.regionGlobal }).getAttribute('aria-controls')
    expect(document.getElementById(other as string)).not.toBeNull()
  })

  it('shows the expiring-soon advice as visible text', async () => {
    const trae = buildTraeReady({
      warnings: [],
      accounts: [
        buildAccount({ id: 'trae-a', label: 'alice@example.com', selected: true, refreshExpiresAt: NOW + DAY }),
        buildAccount({ id: 'trae-b', label: 'bob@example.com', selected: false }),
      ],
    })
    setup(buildHubStatus([trae]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Trae/ }))
    expect(await screen.findByText(zh.accountExpiryHint)).toBeTruthy()
  })

  it('shows the per-account check-in reward and busy label', async () => {
    setup(buildHubStatus([buildTraeReady()]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Trae/ }))
    await screen.findByRole('radio', { name: zh.accountSelectAria.replace('{account}', 'alice@example.com') })
    const reward = zh.checkinReward.replace('{reward}', '100')
    // One region-level reward tag plus one per claimed account.
    expect(screen.getAllByText(reward)).toHaveLength(3)
  })

  it('dispatches per-account check-in with the account id and an in-flight label', async () => {
    const trae = buildTraeReady({
      checkin: buildCheckin({ state: 'available', reward: 0 }),
      accounts: [
        buildAccount({
          id: 'trae-a',
          label: 'alice@example.com',
          selected: true,
          checkin: buildCheckin({ state: 'available', reward: 0 }),
        }),
        buildAccount({ id: 'trae-b', label: 'bob@example.com', selected: false }),
      ],
    })
    setup(buildHubStatus([trae]))
    let resolveAction: ((reply: ActionReply) => void) | undefined
    actionReply = () => new Promise<ActionReply>((resolve) => { resolveAction = resolve })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Trae/ }))
    const buttons = await screen.findAllByRole('button', { name: /立即签到/ })
    fireEvent.click(buttons[0] as HTMLElement)
    await waitFor(() => {
      expect(dispatched).toContainEqual({ type: 'checkin', provider: 'trae', accountId: 'trae-a' })
    })
    expect(await screen.findAllByRole('button', { name: /签到中/ })).toHaveLength(1)
    resolveAction?.({ ok: true, status: currentStatus })
  })

  it('shows the in-flight label for a multi-account client with one account', async () => {
    const trae = buildTraeReady({
      accounts: [
        buildAccount({
          id: 'trae-a',
          label: 'alice@example.com',
          selected: true,
          checkin: buildCheckin({ state: 'available', reward: 0 }),
        }),
      ],
      checkin: buildCheckin({ state: 'available', reward: 0 }),
    })
    setup(buildHubStatus([trae]))
    let resolveAction: ((reply: ActionReply) => void) | undefined
    actionReply = () => new Promise<ActionReply>((resolve) => { resolveAction = resolve })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Trae/ }))
    fireEvent.click(await screen.findByRole('button', { name: zh.checkinNow }))
    expect(await screen.findByRole('button', { name: zh.checkinBusy })).toBeTruthy()
    resolveAction?.({ ok: true, status: currentStatus })
  })

  it('shows the in-flight re-read label for WorkBuddy', async () => {
    setup(buildHubStatus([buildWorkBuddyReady()]))
    let resolveAction: ((reply: ActionReply) => void) | undefined
    actionReply = () => new Promise<ActionReply>((resolve) => { resolveAction = resolve })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /WorkBuddy/ }))
    fireEvent.click(await screen.findByRole('button', { name: zh.refreshAccount }))
    expect(await screen.findByRole('button', { name: zh.refreshAccountBusy })).toBeTruthy()
    resolveAction?.({ ok: true, status: currentStatus })
  })

  it('drops a check-in time draft when the provider changes', async () => {
    setup(buildHubStatus(buildAllProviders()))
    renderPage()
    await screen.findByText('Qwen3 Coder')
    const input = screen.getByLabelText(zh.checkinTimeLabel) as HTMLInputElement
    fireEvent.change(input, { target: { value: '12:30' } })
    expect(input.value).toBe('12:30')
    fireEvent.click(screen.getByRole('button', { name: /Trae/ }))
    await waitFor(() => { expect(screen.getByLabelText(zh.checkinTimeLabel)).not.toBe(input) })
    fireEvent.click(screen.getByRole('button', { name: /Qoder/ }))
    const reopened = await screen.findByLabelText(zh.checkinTimeLabel) as HTMLInputElement
    expect(reopened.value).toBe('10:00')
  })

  it('shows each Trae account once with expiry facts and no inline check-in button', async () => {
    setup(buildHubStatus([buildTraeReady()]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Trae/ }))
    await screen.findByRole('radio', { name: zh.accountSelectAria.replace('{account}', 'alice@example.com') })
    const card = screen.getByText(zh.sectionConnection).closest('section') as HTMLElement
    expect(card.querySelectorAll('.ch-account')).toHaveLength(2)
    expect(within(card).getAllByRole('radio')).toHaveLength(2)
    expect(within(card).getAllByText(zh.accountExpires)).toHaveLength(2)
    expect(within(card).queryByRole('button', { name: zh.checkinNow })).toBeNull()
  })
})

describe('formatting edge', () => {
  it('does not render a check-in section for a provider without the capability', async () => {
    const workbuddy = buildWorkBuddyReady({ capabilities: { usage: false, checkin: false, transfer: false, probes: false, multiAccount: false } })
    setup(buildHubStatus([workbuddy]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /WorkBuddy/ }))
    await screen.findByText('WorkBuddy Pro')
    expect(screen.queryByText(zh.sectionCredits)).toBeNull()
    expect(screen.queryByText(zh.sectionCheckin)).toBeNull()
    expect(screen.queryByText(zh.sectionProbes)).toBeNull()
  })

  it('shows one minimal page for an unconfigured provider on every family', async () => {
    setup(buildHubStatus(buildAllProviders()))
    renderPage()
    await screen.findByText('Qwen3 Coder')
    fireEvent.click(screen.getByRole('tab', { name: zh.regionGlobal }))
    await waitFor(() => { expect(screen.queryByText(zh.sectionCredits)).toBeNull() })
    // Qoder Global is signed out: no credit, check-in or probe card, exactly
    // like the other two families in the same state.
    expect(screen.queryByText(zh.sectionCheckin)).toBeNull()
    expect(screen.queryByText(zh.sectionProbes)).toBeNull()
    expect(screen.getByText(zh.sectionConnection)).toBeTruthy()
    expect(screen.getByText(zh.desktopSignInMissing.replaceAll('{app}', 'Qoder'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /WorkBuddy/ }))
    await waitFor(() => { expect(screen.queryByText(zh.sectionCredits)).toBeNull() })
    expect(screen.queryByText(zh.sectionProbes)).toBeNull()
    expect(screen.getByText(zh.desktopSignInMissing.replaceAll('{app}', zh.providerWorkbuddyAi))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Trae/ }))
    await waitFor(() => { expect(screen.queryByText(zh.sectionCredits)).toBeNull() })
    expect(screen.queryByText(zh.sectionTransfer)).toBeNull()
    expect(screen.getByText(zh.desktopSignInMissing.replaceAll('{app}', 'Trae'))).toBeTruthy()
  })

  it('does not repeat a bare sign-in warning in diagnostics while signed out', async () => {
    const signedOut = buildProvider('qoder-global', {
      state: 'needs-credential',
      warnings: [buildWarning({ code: 'no-credential', level: 'info', message: 'No Qoder desktop sign-in was found' })],
      capabilities: { usage: true, checkin: true, transfer: false, probes: false, multiAccount: false },
    })
    setup(buildHubStatus([signedOut]))
    renderPage()
    fireEvent.click(await screen.findByRole('tab', { name: zh.regionGlobal }))
    await waitFor(() => { expect(screen.getByText(zh.desktopSignInMissing.replaceAll('{app}', 'Qoder'))).toBeTruthy() })
    // The connection card states it and offers the fix; the diagnostics card
    // would only repeat the same sentence.
    expect(screen.queryByText(zh.warningsTitle)).toBeNull()
  })

  it('keeps a non-sign-in diagnostic while trimming the bare sign-in notice', async () => {
    const signedOut = buildProvider('qoder-global', {
      state: 'needs-credential',
      warnings: [
        buildWarning({ code: 'no-credential', level: 'info', message: 'No Qoder desktop sign-in was found' }),
        buildWarning({ code: 'desktop-login-unreadable', level: 'info', message: '无法读取 Qoder 桌面端登录状态' }),
      ],
      capabilities: { usage: true, checkin: true, transfer: false, probes: false, multiAccount: false },
    })
    setup(buildHubStatus([signedOut]))
    renderPage()
    fireEvent.click(await screen.findByRole('tab', { name: zh.regionGlobal }))
    expect(await screen.findByText(zh.warningsTitle)).toBeTruthy()
    expect(screen.getByText(zh.warningDesktopLoginUnreadable)).toBeTruthy()
    expect(screen.getByText(zh.warningsCount.replace('{count}', '1'))).toBeTruthy()
    expect(screen.queryByText(zh.warningNoCredential)).toBeNull()
  })

  it('shows the max-context switch on for a mixed catalog once enabled', async () => {
    const qoder = buildQoderReady({
      catalog: {
        source: 'live',
        updatedAt: NOW,
        models: [
          buildModel({ id: 'a', name: 'Model A', contextWindow: 200_000, maxContextWindow: 1_000_000, useMaxContext: true }),
          buildModel({ id: 'b', name: 'Model B', contextWindow: 200_000, maxContextWindow: 200_000, useMaxContext: false }),
        ],
      },
    })
    setup(buildHubStatus([qoder]))
    renderPage()
    await screen.findByText('Model A')
    expect(screen.getByRole('switch', { name: zh.maxContext }).getAttribute('aria-checked')).toBe('true')
  })

  it('labels an imported Trae credential as imported, not as an app sign-in', async () => {
    const trae = buildTraeReady({
      credential: { source: 'plugin', masked: '****imp1', writable: false, imported: true },
    })
    setup(buildHubStatus([trae]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Trae/ }))
    expect(await screen.findByText(zh.sourceImported)).toBeTruthy()
    expect(screen.queryByText(zh.sourceAppRefreshed)).toBeNull()
  })

  it('hides the max-context switch when the catalog advertises no larger window', async () => {
    const qoder = buildQoderReady({
      catalog: { source: 'live', updatedAt: NOW, models: [buildModel({ contextWindow: 200_000, maxContextWindow: 200_000 })] },
    })
    setup(buildHubStatus([qoder]))
    renderPage()
    await screen.findByText('Qwen3 Coder')
    expect(screen.queryByRole('switch', { name: zh.maxContext })).toBeNull()
  })

  it('renders package expiries from the credits card', async () => {
    const status = buildHubStatus([buildQoderReady({ credits: {
      kind: 'credits',
      remaining: 240,
      total: 2_000,
      updatedAt: NOW - 600_000,
      packages: [{ id: 'p1', name: '体验包', remaining: 40, total: 100, expiresAt: NOW + 6 * DAY }],
    } })])
    setup(status)
    renderPage()
    expect(await screen.findByText('体验包')).toBeTruthy()
    expect(screen.getByText(zh.creditsPackageLine.replace('{remaining}', '40').replace('{total}', '100'))).toBeTruthy()
  })
})
