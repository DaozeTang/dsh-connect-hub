/** pi-ai generation detection: version classification and failure degradation. */

import { describe, expect, it } from 'vitest'
import { detectPiAiRuntime } from '../../src/core/pi-ai.ts'

const ENTRY = 'file:///opt/dsh/node_modules/@earendil-works/pi-ai/dist/index.js'

function withVersion(version: string | undefined): Promise<unknown> {
  return detectPiAiRuntime({
    resolve: () => ENTRY,
    readManifest: async () => version,
  })
}

describe('detectPiAiRuntime', () => {
  it('classifies a modern pi-ai generation', async () => {
    await expect(withVersion('1.3.0')).resolves.toEqual({ version: '1.3.0', generation: 'modern' })
    await expect(withVersion('0.86.0')).resolves.toEqual({ version: '0.86.0', generation: 'modern' })
  })

  it('classifies the legacy generation', async () => {
    await expect(withVersion('0.85.1')).resolves.toEqual({ version: '0.85.1', generation: 'legacy' })
  })

  it('degrades to unknown when resolution fails or no manifest names the package', async () => {
    await expect(detectPiAiRuntime({ resolve: () => { throw new Error('not installed') } }))
      .resolves.toEqual({ version: undefined, generation: 'unknown' })
    await expect(withVersion(undefined)).resolves.toEqual({ version: undefined, generation: 'unknown' })
  })

  it('resolves the installed dependency through the default path', async () => {
    const runtime = await detectPiAiRuntime()
    expect(runtime.version).toMatch(/^\d+\.\d+\.\d+/u)
    expect(['modern', 'legacy']).toContain(runtime.generation)
  })
})
