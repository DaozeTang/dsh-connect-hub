/**
 * Adversarial tests around WorkBuddy's Electron decrypt child process:
 * no shell / no secret argv (source-level and helper-contract checks), bounded
 * envelope parsing, tamper rejection, and the WSL environment hand-off.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildAuthenticatedContextAad,
  classifyDesktopAuthDocument,
  helperChildEnv,
  keyIdsOf,
  openAuthField,
  parseAtRestPayload,
  unwrapDesktopAuthDocument,
  wslenvForwardRunAsNode,
} from '../../src/providers/workbuddy/desktop-credential-protection.ts'
import { sealAuthFieldForTest } from '../support/wb-seal.ts'

const SOURCE = join(import.meta.dirname, '../../src/providers/workbuddy/desktop-credential-protection.ts')

describe('decrypt helper process', () => {
  it('is invoked through execFile without a shell and without secret argv', async () => {
    const source = await readFile(SOURCE, 'utf8')
    // execFile takes an argv array; a shell-integrated primitive would allow
    // metacharacter injection through paths or environment values.
    expect(source).toContain("import { execFile } from 'node:child_process'")
    expect(source).not.toMatch(/(?<![.\w])exec\(/)
    expect(source).not.toMatch(/\bexecSync\(/)
    expect(source).not.toMatch(/\bspawnSync\(/)
    expect(source).not.toMatch(/shell\s*:\s*true/)
    // The helper argv is a fixed flag and a fixed script; no credential value
    // is ever interpolated into the command line.
    expect(source).toContain("const HELPER_SCRIPT_ARGUMENT_FLAG = '-e'")
    expect(source).not.toMatch(/HELPER_SCRIPT\s*=\s*[`'"][^`'"]*\$\{/)
  })

  it('bounds the child: explicit timeout and output cap', async () => {
    const source = await readFile(SOURCE, 'utf8')
    expect(source).toMatch(/timeout:\s*this\.timeoutMs/)
    expect(source).toMatch(/maxBuffer:\s*1024\s*\*\s*1024/)
    expect(source).toContain('windowsHide: true')
  })

  it('passes a minimized allowlisted environment, not the whole parent env', () => {
    const env = helperChildEnv({
      PATH: '/usr/bin',
      HOME: '/Users/alice',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      SOME_TOKEN: 'secret-value',
      DSH_SECRET: 'another-secret',
    }, '/Applications/WorkBuddy.app/Electron', false)
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1')
    // Needed for Electron/Node startup on the supported platforms:
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['HOME']).toBe('/Users/alice')
    expect(env['LANG']).toBe('en_US.UTF-8')
    expect(env['TMPDIR']).toBe('/tmp')
    // Anything else must not reach the third-party binary:
    expect(env['SOME_TOKEN']).toBeUndefined()
    expect(env['DSH_SECRET']).toBeUndefined()
  })

  it('only forwards ELECTRON_RUN_AS_NODE through WSLENV, for a Windows binary', () => {
    expect(wslenvForwardRunAsNode('FOO/p:ELECTRON_RUN_AS_NODE:bar')).toBe('FOO/p:ELECTRON_RUN_AS_NODE/w:bar')
    expect(wslenvForwardRunAsNode('ELECTRON_RUN_AS_NODE:ELECTRON_RUN_AS_NODE/u')).toBe('ELECTRON_RUN_AS_NODE/uw')
    expect(wslenvForwardRunAsNode(undefined)).toBe('ELECTRON_RUN_AS_NODE/w')
    const native = helperChildEnv({ WSLENV: 'FOO' }, '/usr/bin/electron', true)
    expect(native['WSLENV']).toBe('FOO')
    const windows = helperChildEnv({ WSLENV: 'FOO' }, 'C:\\WorkBuddy\\WorkBuddy.exe', true)
    expect(windows['WSLENV']).toBe('FOO:ELECTRON_RUN_AS_NODE/w')
  })
})

describe('at-rest payload and envelope parsing', () => {
  it('accepts only a canonical 32-byte non-zero base64 secret', () => {
    const valid = Buffer.alloc(32, 7).toString('base64')
    expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: valid }))).toEqual({ atRestSecretKey: valid })
    expect(parseAtRestPayload(JSON.stringify({ version: 2, atRestSecretKey: valid }))).toBeUndefined()
    expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(16, 7).toString('base64') }))).toBeUndefined()
    expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32, 0).toString('base64') }))).toBeUndefined()
    expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: 'not base64 @@' }))).toBeUndefined()
    expect(parseAtRestPayload('{"version":1}')).toBeUndefined()
  })

  it('rejects tampered ciphertext, tags, keys and AAD key ids', () => {
    const key = Buffer.alloc(32, 9)
    const sealed = sealAuthFieldForTest(key, 'access-token-value')
    const classification = classifyDesktopAuthDocument(JSON.stringify({ accessToken: sealed }))
    expect(classification.format).toBe('encrypted')
    if (classification.format !== 'encrypted') return
    const wrapped = classification.wrapped.fields[0]!
    expect(openAuthField(key, wrapped.envelope)).toBe('access-token-value')

    const wrongKey = Buffer.alloc(32, 10)
    expect(openAuthField(wrongKey, wrapped.envelope)).toBeUndefined()

    const tamperedCiphertext = {
      ...wrapped.envelope,
      ciphertext: Buffer.from('tampered', 'utf8'),
    }
    expect(openAuthField(key, tamperedCiphertext)).toBeUndefined()

    const tamperedTag = { ...wrapped.envelope, authTag: Buffer.alloc(16, 0) }
    expect(openAuthField(key, tamperedTag)).toBeUndefined()

    // The AAD binds key id and suite; changing them must break the open.
    const otherAad = buildAuthenticatedContextAad('0123456789abcdef', 1)
    expect(otherAad.length).toBeGreaterThan(0)
    expect(openAuthField(key, { ...wrapped.envelope, keyId: 'ffffffffffffffff' })).toBeUndefined()
  })

  it('treats un-parsable wrappers or extra string fields as unrecognized/plaintext safely', () => {
    expect(classifyDesktopAuthDocument('{"accessToken":{"$wbEncrypted":1,"envelope":"%%%"}}').format).toBe('unrecognized')
    expect(classifyDesktopAuthDocument('{"accessToken":42}').format).toBe('unrecognized')
    expect(classifyDesktopAuthDocument('[]').format).toBe('unrecognized')
    expect(classifyDesktopAuthDocument('not json').format).toBe('unrecognized')
  })

  it('rebuilds the document without dropping unrelated fields', () => {
    const key = Buffer.alloc(32, 3)
    const sealed = sealAuthFieldForTest(key, 'tok')
    const classification = classifyDesktopAuthDocument(JSON.stringify({ auth: { accessToken: sealed }, account: { uid: 'u' } }))
    if (classification.format !== 'encrypted') throw new Error('expected encrypted')
    expect(keyIdsOf(classification.wrapped.fields)).toHaveLength(1)
    const rebuilt = JSON.parse(unwrapDesktopAuthDocument(classification, () => 'plain-token')) as {
      auth: { accessToken: string },
      account: { uid: string },
    }
    expect(rebuilt.auth.accessToken).toBe('plain-token')
    expect(rebuilt.account.uid).toBe('u')
  })
})
