import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'

const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE })
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function writeTextFile(path: string, text: string): Promise<void> {
  await ensurePrivateDir(dirname(path))
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(temp, 'w', PRIVATE_FILE_MODE)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(temp, PRIVATE_FILE_MODE)
  await rename(temp, path)
}
