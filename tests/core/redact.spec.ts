import { describe, expect, it } from 'vitest'
import { maskTail, redactHome, redactText } from '../../src/core/redact.ts'

const PAT = 'pat_1234567890abcdefghijklmnop'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl'

describe('redactText', () => {
  it('removes a known secret wherever it appears', () => {
    const text = redactText(`failed with ${PAT} and again ${PAT}`, [PAT])
    expect(text).not.toContain(PAT)
    expect(text.match(/\[redacted\]/g)).toHaveLength(2)
  })

  it('removes JWT and bearer credentials', () => {
    const text = redactText(`Authorization: Bearer ${JWT}`)
    expect(text).not.toContain(JWT)
    expect(text).not.toContain('Bearer eyJ')
  })

  it('removes PEM private keys', () => {
    const text = redactText('before -----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY----- after')
    expect(text).toBe('before [redacted key] after')
  })

  it('removes key/value secrets and long hex seeds', () => {
    const text = redactText('pat=abc123 refresh_token: zzz 0123456789abcdef0123456789abcdef0123456789abcdef')
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('zzz')
    expect(text).not.toContain('0123456789abcdef0123456789abcdef0123456789abcdef')
  })

  it('leaves ordinary prose intact', () => {
    expect(redactText('模型目录已更新于 10:00')).toBe('模型目录已更新于 10:00')
  })
})

describe('redactHome', () => {
  it('shortens the home directory', () => {
    expect(redactHome('/Users/alice/.dsh/file.json', '/Users/alice')).toBe('~/.dsh/file.json')
  })
})

describe('maskTail', () => {
  it('keeps only the last characters', () => {
    expect(maskTail('abcdefghijkl')).toBe('****ijkl')
    expect(maskTail('abc')).toBe('****')
    expect(maskTail(undefined)).toBeUndefined()
  })
})
