// @vitest-environment jsdom
/**
 * Composer readout tests: visibility gating by the session's selected model
 * provider, the seat preference, and the anchored popover with its manual
 * refresh. The design-system atoms are mocked down to semantic DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    SegmentedControl: ({ options, onChange, label }: Record<string, unknown>) =>
      h('div', { role: 'tablist', 'aria-label': label }, ...(options as { value: string; label: string }[]).map((option) =>
        h('button', {
          key: option.value,
          type: 'button',
          role: 'tab',
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

import { ComposerReadout } from '../../src/client/ComposerReadout.tsx'
import type { ComposerReadoutProps } from '../../src/client/ComposerReadout.tsx'
import type { ConnectHubTranslate } from '../../src/client/format.ts'
import { en, zh } from '../../src/client/locales.ts'
import type { ConnectHubKey } from '../../src/client/locales.ts'
import { clientPreferences } from '../../src/client/prefs.ts'
import { composerStatus } from '../../src/client/status-source.ts'
import type { HubStatus, ProviderStatus } from '../../src/shared/contracts.ts'
import { buildHubStatus, buildPlanCredits, buildProvider, buildQoderReady } from './fixtures.ts'

function makeT(locale: 'zh' | 'en' = 'zh'): ConnectHubTranslate {
  const dictionary: Record<string, string> = locale === 'zh' ? zh : en
  return ((key: ConnectHubKey, params?: Record<string, unknown>) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])))
  }) as ConnectHubTranslate
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

let fetchCount = 0
let currentStatus: HubStatus

function installFetch(): void {
  fetchCount = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).endsWith('/status')) throw new Error(`unexpected fetch: ${String(input)}`)
    fetchCount += 1
    return json(currentStatus)
  }))
}

function readoutProps(provider: string | undefined, model = 'some-model'): ComposerReadoutProps {
  const projection = provider === undefined
    ? undefined
    : { next: { provider, model, reasoningEffort: null }, lastUsed: null }
  return {
    t: makeT('zh'),
    useProjection: (key: string) => (key === 'modelSelection' ? projection : undefined),
  } as unknown as ComposerReadoutProps
}

beforeEach(() => {
  composerStatus.reset()
  clientPreferences.setSeat('toolbar')
  currentStatus = buildHubStatus([buildQoderReady()])
  installFetch()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('readout visibility', () => {
  it('renders when the session model belongs to this plugin', async () => {
    render(<ComposerReadout {...readoutProps('qoder')} seat="toolbar" />)
    const button = await screen.findByRole('button', { name: /Qoder：/ })
    expect(button.textContent).toContain('1,240')
    expect(fetchCount).toBe(1)
  })

  it('renders nothing for another provider and starts no request', async () => {
    const { container } = render(<ComposerReadout {...readoutProps('deepseek-official')} seat="toolbar" />)
    await waitFor(() => { expect(container.textContent).toBe('') })
    expect(screen.queryByRole('button')).toBeNull()
    expect(fetchCount).toBe(0)
  })

  it('renders nothing when no provider is selected', async () => {
    const { container } = render(<ComposerReadout {...readoutProps(undefined)} seat="toolbar" />)
    expect(container.textContent).toBe('')
    expect(fetchCount).toBe(0)
  })

  it('lets only the preferred seat draw', async () => {
    clientPreferences.setSeat('dock')
    const toolbar = render(<ComposerReadout {...readoutProps('qoder')} seat="toolbar" />)
    await waitFor(() => { expect(toolbar.container.textContent).toBe('') })
    render(<ComposerReadout {...readoutProps('qoder')} seat="dock" />)
    expect(await screen.findByRole('button', { name: /Qoder：/ })).toBeTruthy()
  })

  it('falls back to the plan when no credit amount is reported', async () => {
    const planProvider: ProviderStatus = buildProvider('qoder', {
      state: 'ready',
      credits: buildPlanCredits('Pro 会员'),
    })
    currentStatus = buildHubStatus([planProvider])
    render(<ComposerReadout {...readoutProps('qoder')} seat="toolbar" />)
    const button = await screen.findByRole('button', { name: /Qoder：/ })
    expect(button.textContent).toContain('Pro 会员')
  })

  it('localizes a known plan label in the English readout and popover', async () => {
    const planProvider: ProviderStatus = buildProvider('qoder', {
      state: 'ready',
      credits: buildPlanCredits('不限额度'),
    })
    currentStatus = buildHubStatus([planProvider])
    render(<ComposerReadout {...readoutProps('qoder')} t={makeT('en')} seat="toolbar" />)
    const button = await screen.findByRole('button', { name: /Qoder/ })
    expect(button.textContent).toContain(en.planUnlimited)
    expect(button.textContent).not.toContain('不限额度')

    fireEvent.click(button)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(en.planUnlimited)
    expect(dialog.textContent).not.toContain('不限额度')
  })
})

describe('readout popover', () => {
  it('opens with provider detail, refreshes manually and closes on Escape', async () => {
    render(<ComposerReadout {...readoutProps('qoder')} seat="toolbar" />)
    const button = await screen.findByRole('button', { name: /Qoder：/ })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(button)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toContain('Qoder')
    expect(dialog.textContent).toContain('1,240')
    expect(fetchCount).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: zh.popoverRefresh }))
    await waitFor(() => { expect(fetchCount).toBe(2) })

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('closes when the readout is clicked again', async () => {
    render(<ComposerReadout {...readoutProps('qoder')} seat="toolbar" />)
    const button = await screen.findByRole('button', { name: /Qoder：/ })
    fireEvent.click(button)
    await screen.findByRole('dialog')
    fireEvent.click(button)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('shows a not-connected summary when the provider is not in the status', async () => {
    currentStatus = buildHubStatus([])
    render(<ComposerReadout {...readoutProps('qoder')} seat="toolbar" />)
    const button = await screen.findByRole('button', { name: /Qoder：/ })
    expect(button.textContent).toContain(zh.readoutUnknown)
    fireEvent.click(button)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(zh.popoverNoData)
  })

  it('does not poll: one read on show and no extra reads on rerender', async () => {
    const { rerender } = render(<ComposerReadout {...readoutProps('qoder')} seat="toolbar" />)
    await screen.findByRole('button', { name: /Qoder：/ })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(fetchCount).toBe(1)
    rerender(<ComposerReadout {...readoutProps('qoder')} seat="toolbar" />)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(fetchCount).toBe(1)
  })
})
