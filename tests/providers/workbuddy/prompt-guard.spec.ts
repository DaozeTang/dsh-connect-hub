import { describe, expect, it } from 'vitest'
import {
  GUARDED_PHRASES,
  GUARD_JOINER,
  neutralizeBody,
  neutralizeText,
} from '../../../src/providers/workbuddy/prompt-guard.ts'
import { prepareCnChatBody, prepareInternationalChatBody } from '../../../src/providers/workbuddy/upstream.ts'

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

function harnessSystemPrompt(): string {
  return [
    IDENTITY,
    '',
    'Runtime context: /Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/',
    '',
    'Tool usage guidance and repository conventions. '.repeat(20),
  ].join('\n')
}

describe('neutralizeText', () => {
  it('breaks the identity sentence with an invisible joiner', () => {
    const result = neutralizeText(IDENTITY)
    expect(result.replacements).toBe(1)
    expect(result.text).toContain(GUARD_JOINER)
    expect(result.text.replaceAll(GUARD_JOINER, '')).toBe(IDENTITY)
  })

  it('matches case-insensitively', () => {
    const result = neutralizeText(IDENTITY.toLowerCase())
    expect(result.replacements).toBe(1)
    expect(result.text).toContain(GUARD_JOINER)
  })

  it('leaves the text unchanged when no guarded phrase is present', () => {
    const plain = 'You are a helpful assistant. Answer concisely.'
    const result = neutralizeText(plain)
    expect(result.replacements).toBe(0)
    expect(result.text).toBe(plain)
  })

  it('leaves the empty string alone', () => {
    expect(neutralizeText('')).toEqual({ text: '', replacements: 0 })
  })

  it('is idempotent', () => {
    const once = neutralizeText(IDENTITY)
    const twice = neutralizeText(once.text)
    expect(twice.replacements).toBe(0)
    expect(twice.text).toBe(once.text)
  })
})

describe('neutralizeText path safety', () => {
  const protectedTexts = [
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/',
    'D:\\10_COD\\DeepSeek Harness\\resources\\app.asar\\dsh\\',
    'Open ~/Library/Application Support/DeepSeek Harness/settings.json',
    'See https://example.com/DeepSeek Harness/docs',
  ]

  for (const text of protectedTexts) {
    it(`never rewrites a path: ${text.slice(0, 36)}…`, () => {
      const result = neutralizeText(text)
      expect(result.replacements).toBe(0)
      expect(result.text).toBe(text)
    })
  }

  it('rewrites the identity sentence while leaving a sibling path byte-identical', () => {
    const path = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/'
    const text = `${IDENTITY}\nRoot: ${path}`
    const result = neutralizeText(text)
    expect(result.replacements).toBe(1)
    expect(result.text).toContain(path)
    expect(result.text.replaceAll(GUARD_JOINER, '')).toBe(text)
  })
})

describe('neutralizeBody', () => {
  const systemBody = (content: string): Record<string, unknown> => ({
    model: 'glm-5.3',
    messages: [{ role: 'system', content }, { role: 'user', content: IDENTITY }],
  })

  it('rewrites a system message and reports the count', () => {
    const body = systemBody(IDENTITY)
    expect(neutralizeBody(body)).toBe(1)
    const messages = body['messages'] as Array<Record<string, unknown>>
    expect(messages[0]?.['content']).toContain(GUARD_JOINER)
  })

  it('never rewrites user content, which the gateway does not inspect', () => {
    const body = systemBody('A neutral system prompt.')
    neutralizeBody(body)
    const messages = body['messages'] as Array<Record<string, unknown>>
    expect(messages[1]?.['content']).toBe(IDENTITY)
  })

  it('rewrites developer messages, which the wire layer sends as system', () => {
    const body = { messages: [{ role: 'developer', content: IDENTITY }] }
    expect(neutralizeBody(body)).toBe(1)
  })

  it('ignores non-string content and malformed messages', () => {
    const body = {
      messages: [
        { role: 'system', content: [{ type: 'text', text: IDENTITY }] },
        { role: 'system', content: null },
        'not-a-message',
        null,
      ],
    }
    expect(neutralizeBody(body)).toBe(0)
  })

  it('tolerates a body without messages', () => {
    expect(neutralizeBody({ model: 'glm-5.3' })).toBe(0)
    expect(neutralizeBody({ messages: 'nope' })).toBe(0)
  })
})

describe('prepareCnChatBody', () => {
  it('neutralizes the harness system prompt and keeps its path intact', () => {
    const prepared = prepareCnChatBody(JSON.stringify({
      model: 'glm-5.3',
      messages: [{ role: 'system', content: harnessSystemPrompt() }, { role: 'user', content: 'ping' }],
    }))
    const body = JSON.parse(prepared) as { messages: Array<{ content: string }> }
    const system = body.messages[0]?.content ?? ''
    expect(system).toContain(GUARD_JOINER)
    expect(system).toContain('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/')
  })

  it('still flattens reasoning_effort "off" as before', () => {
    const prepared = prepareCnChatBody(JSON.stringify({
      model: 'glm-5.3',
      reasoning_effort: 'off',
      messages: [{ role: 'system', content: 'neutral' }],
    }))
    expect(JSON.parse(prepared)).not.toHaveProperty('reasoning_effort')
  })

  it('returns non-JSON input unchanged', () => {
    expect(prepareCnChatBody('not json')).toBe('not json')
  })
})

describe('prepareInternationalChatBody', () => {
  it('keeps the existing system message position and neutralizes it', () => {
    const prepared = prepareInternationalChatBody(JSON.stringify({
      messages: [{ role: 'system', content: IDENTITY }, { role: 'user', content: 'ping' }],
    }))
    const body = JSON.parse(prepared) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0]?.role).toBe('system')
    expect(body.messages[0]?.content).toContain(GUARD_JOINER)
  })

  it('injects a fallback system prompt when the body has none, then neutralizes', () => {
    const prepared = prepareInternationalChatBody(JSON.stringify({
      messages: [{ role: 'user', content: 'ping' }],
    }))
    const body = JSON.parse(prepared) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0]?.role).toBe('system')
    expect(body.messages[0]?.content).not.toContain(GUARD_JOINER)
  })
})

describe('GUARDED_PHRASES', () => {
  it('covers the identity sentence the harness actually emits', () => {
    const covered = GUARDED_PHRASES.some(
      (phrase) => phrase.toLowerCase() === IDENTITY.replace(/\.$/u, '').toLowerCase(),
    )
    expect(covered).toBe(true)
  })
})
