import { describe, expect, it } from 'vitest'
import type { Context } from '@earendil-works/pi-ai'
import {
  adaptLegacyPiAiContext,
  adaptModernPiAiContext,
  withContextAdaptation,
} from '../../../src/providers/trae/adapter.ts'
import { decidePiAiGeneration, generationOf } from '../../../src/providers/trae/pi-ai-runtime.ts'

/** The normalized (0.86+) transcript shape a modern host hands to a provider. */
function modernContext(): Context {
  return {
    messages: [{
      role: 'system',
      content: 'you are helpful',
      sections: { rules: 'be terse' },
      toolsAdded: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    }, { role: 'user', content: 'hi' }],
  } as unknown as Context
}

describe('pi-ai generation decision', () => {
  it('treats 0.86+ and the 1.x line as modern and ≤0.85 as legacy', () => {
    expect(generationOf('0.85.1')).toBe('legacy')
    expect(generationOf('0.86.0')).toBe('modern')
    expect(generationOf('1.3.0')).toBe('modern')
    expect(generationOf('2.0.0')).toBe('modern')
    expect(generationOf(undefined)).toBeUndefined()
    expect(generationOf('not-a-version')).toBeUndefined()
  })

  it('falls back to the shipped transcript module, then to pass-through', () => {
    expect(decidePiAiGeneration(undefined, true)).toBe('modern')
    expect(decidePiAiGeneration(undefined, false)).toBe('legacy')
    expect(decidePiAiGeneration(undefined, undefined)).toBe('modern')
  })
})

describe('legacy context folding', () => {
  it('lifts the prompt and tool declarations out of a normalized transcript', () => {
    const folded = adaptLegacyPiAiContext(modernContext())
    expect(folded.systemPrompt).toBe('you are helpful\n\nbe terse')
    expect(folded.tools?.map(tool => tool.name)).toEqual(['read'])
    expect(folded.messages).toHaveLength(1)
    expect(folded.messages[0]).toMatchObject({ role: 'user' })
  })

  it('is an identity for a context with no system message', () => {
    const legacy = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context
    expect(adaptLegacyPiAiContext(legacy)).toBe(legacy)
  })
})

describe('modern context lifting', () => {
  it('reconstructs the system message a modern api reads', () => {
    const lifted = adaptModernPiAiContext({
      systemPrompt: 'you are helpful',
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as Context)
    expect(lifted.messages[0]).toMatchObject({
      role: 'system',
      content: 'you are helpful',
      toolsAdded: [expect.objectContaining({ name: 'read' })],
    })
    expect('systemPrompt' in lifted).toBe(false)
    expect('tools' in lifted).toBe(false)
  })

  it('is an identity when there is neither a prompt nor tools', () => {
    const modern = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context
    expect(adaptModernPiAiContext(modern)).toBe(modern)
  })
})

describe('withContextAdaptation', () => {
  it('passes the context through the generation-appropriate seam and leaves the api methods intact', () => {
    let seen: Context | undefined
    const api = {
      stream: ((_model: unknown, context: unknown) => {
        seen = context as Context
        return undefined as never
      }) as never,
      streamSimple: (() => undefined as never) as never,
    }
    const wrapped = withContextAdaptation(api, 'legacy')
    wrapped.stream({} as never, modernContext() as never, undefined)
    expect(seen?.systemPrompt).toBe('you are helpful\n\nbe terse')
  })
})
