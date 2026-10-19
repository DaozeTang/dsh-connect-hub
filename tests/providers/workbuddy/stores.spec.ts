import { describe, expect, it } from 'vitest'
import { WorkBuddyCatalogStore, isSavedCatalog } from '../../../src/providers/workbuddy/catalog-store.ts'
import { WorkBuddyVisibilityStore, isSavedVisibility } from '../../../src/providers/workbuddy/visibility-store.ts'
import type { WorkBuddyUpstreamModel } from '../../../src/providers/workbuddy/upstream.ts'
import { FakePrefs } from './helpers.ts'

const MODEL: WorkBuddyUpstreamModel = {
  id: 'glm-5.3',
  name: 'GLM-5.3',
  contextWindow: 1_000_000,
  maxTokens: 64_000,
  supportsImages: true,
}

describe('WorkBuddyVisibilityStore', () => {
  it('starts empty and hides per account', async () => {
    const prefs = new FakePrefs()
    const store = new WorkBuddyVisibilityStore(prefs, 'provider:workbuddy:visibility')
    await store.load()
    expect(store.disabled('uid-1:')).toEqual([])
    await store.setVisible('uid-1:', 'glm-5.3', false)
    await store.setVisible('uid-1:', 'kimi-k2.6', false)
    expect(store.disabled('uid-1:')).toEqual(['glm-5.3', 'kimi-k2.6'])
    // Another account's list is untouched.
    expect(store.disabled('uid-2:')).toEqual([])
  })

  it('re-enabling the last hidden model removes the account entry', async () => {
    const prefs = new FakePrefs()
    const store = new WorkBuddyVisibilityStore(prefs, 'visibility')
    await store.load()
    await store.setVisible('uid-1:', 'glm-5.3', false)
    await store.setVisible('uid-1:', 'glm-5.3', true)
    expect(store.disabled('uid-1:')).toEqual([])
    expect(store.snapshot()).toEqual({})
    const document = prefs.values.get('visibility') as { accounts: Record<string, unknown> }
    expect(document.accounts).toEqual({})
  })

  it('persists and reloads per account, keeping ids that left the catalog', async () => {
    const prefs = new FakePrefs()
    const store = new WorkBuddyVisibilityStore(prefs, 'visibility')
    await store.load()
    await store.setVisible('uid-1:', 'retired-model', false)
    await store.setVisible('uid-1:', 'glm-5.3', false)
    const reopened = new WorkBuddyVisibilityStore(prefs, 'visibility')
    await reopened.load()
    expect(reopened.disabled('uid-1:')).toEqual(['retired-model', 'glm-5.3'])
  })

  it('treats a corrupt document as nothing hidden and rejects bad entries', async () => {
    const prefs = new FakePrefs()
    prefs.values.set('visibility', { version: 1, accounts: { broken: { account: 'broken', disabled: 'nope' } } })
    const store = new WorkBuddyVisibilityStore(prefs, 'visibility')
    await store.load()
    expect(store.disabled('broken')).toEqual([])
    expect(isSavedVisibility({ account: 'a', disabled: [], updatedAtMs: 1 })).toBe(true)
    expect(isSavedVisibility({ account: '', disabled: [], updatedAtMs: 1 })).toBe(false)
    expect(isSavedVisibility({ account: 'a', disabled: [1], updatedAtMs: 1 })).toBe(false)
  })

  it('propagates a write failure instead of claiming the preference was saved', async () => {
    const failing = {
      async get<T>(): Promise<T | undefined> {
        return undefined
      },
      async set(): Promise<void> {
        throw new Error('disk full')
      },
    }
    const store = new WorkBuddyVisibilityStore(failing, 'visibility')
    await store.load()
    await expect(store.setVisible('uid-1:', 'glm-5.3', false)).rejects.toThrow(/disk full/)
    expect(store.disabled('uid-1:')).toEqual([])
  })
})

describe('WorkBuddyCatalogStore', () => {
  const saved = { source: 'workbuddy:cli', fetchedAtMs: 1_700_000_000_000, models: [MODEL] }

  it('keeps one catalog per account', async () => {
    const prefs = new FakePrefs()
    const store = new WorkBuddyCatalogStore(prefs, 'provider:workbuddy:catalog')
    await store.load()
    expect(store.get('uid-1:')).toBeUndefined()
    await store.set('uid-1:', saved)
    expect(store.get('uid-1:')).toMatchObject({ account: 'uid-1:', source: 'workbuddy:cli' })
    expect(store.get('uid-2:')).toBeUndefined()
    await store.delete('uid-1:')
    expect(store.get('uid-1:')).toBeUndefined()
  })

  it('reloads a saved catalog and drops malformed entries', async () => {
    const prefs = new FakePrefs()
    prefs.values.set('catalog', {
      version: 1,
      entries: {
        'uid-1:': { account: 'uid-1:', ...saved },
        broken: { account: 'broken', source: 'x', fetchedAtMs: 1, models: [{ id: '' }] },
      },
    })
    const store = new WorkBuddyCatalogStore(prefs, 'catalog')
    await store.load()
    expect(store.get('uid-1:')?.models.map((model) => model.id)).toEqual(['glm-5.3'])
    expect(store.get('broken')).toBeUndefined()
    expect(isSavedCatalog({ account: 'a', source: 's', fetchedAtMs: 1, models: [MODEL] })).toBe(true)
    expect(isSavedCatalog({ account: 'a', source: 's', fetchedAtMs: 1, models: [] })).toBe(false)
  })

  it('forgets the account catalog on sign-out and persists nothing else', async () => {
    const prefs = new FakePrefs()
    const store = new WorkBuddyCatalogStore(prefs, 'catalog')
    await store.load()
    await store.set('uid-1:', saved)
    await store.set('uid-2:', saved)
    await store.delete('uid-1:')
    const document = prefs.values.get('catalog') as { entries: Record<string, unknown> }
    expect(Object.keys(document.entries)).toEqual(['uid-2:'])
  })

  it('swallows a write failure: the served catalog does not depend on it', async () => {
    const failing = {
      async get<T>(): Promise<T | undefined> {
        return undefined
      },
      async set(): Promise<void> {
        throw new Error('disk full')
      },
    }
    const store = new WorkBuddyCatalogStore(failing, 'catalog')
    await store.load()
    await expect(store.set('uid-1:', saved)).resolves.toBeUndefined()
    expect(store.get('uid-1:')).toBeDefined()
  })
})
