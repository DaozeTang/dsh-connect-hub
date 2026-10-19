import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PrefsStore } from '../../src/core/prefs.ts'
import type { HubPaths } from '../../src/core/paths.ts'

const cleanups: string[] = []

async function makePaths(): Promise<HubPaths> {
  const root = await mkdtemp(join(tmpdir(), 'hub-prefs-'))
  cleanups.push(root)
  return { home: root, dataDir: join(root, 'data'), stateDir: join(root, 'data', 'state') }
}

function silentLog() {
  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log }
  return log
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('PrefsStore', () => {
  it('persists values and reloads them', async () => {
    const paths = await makePaths()
    const store = new PrefsStore(paths, silentLog() as never)
    await store.load()
    await store.set('provider:qoder', { enabledModels: ['a'] })
    await store.patch('provider:qoder', { maxContext: true })
    await store.dispose()

    const reopened = new PrefsStore(paths, silentLog() as never)
    await reopened.load()
    expect(await reopened.get('provider:qoder')).toEqual({ enabledModels: ['a'], maxContext: true })
    await reopened.dispose()
  })

  it('writes a private file', async () => {
    const paths = await makePaths()
    const store = new PrefsStore(paths, silentLog() as never)
    await store.load()
    await store.set('x', 1)
    await store.dispose()
    const file = join(paths.dataDir, 'preferences.json')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, values: { x: 1 } })
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('starts empty for a corrupt document', async () => {
    const paths = await makePaths()
    const store = new PrefsStore(paths, silentLog() as never)
    await store.load()
    await store.set('a', 1)
    await store.dispose()
    const file = join(paths.dataDir, 'preferences.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{not json', 'utf8')
    const reopened = new PrefsStore(paths, silentLog() as never)
    await reopened.load()
    expect(await reopened.get('a')).toBeUndefined()
    await reopened.dispose()
  })
})
