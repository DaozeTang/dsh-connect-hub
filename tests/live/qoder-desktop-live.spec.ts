/**
 * Live end-to-end check of the Qoder desktop-login path: read the real app
 * sign-in from this machine, rotate it through the region endpoint, list models
 * with the rotated device token and run one tiny chat. Opt-in only:
 *
 *   HUB_LIVE_QODER_DESKTOP=1 pnpm exec vitest run tests/live/qoder-desktop-live.spec.ts
 *
 * The test never prints, stores or transmits the credential anywhere except
 * Qoder's own endpoints. The setup file pins the *provider* to a nonexistent
 * fixture path, so this file passes `env: {}` on purpose to reach the machine's
 * real desktop record. It rotates the pair twice (asserting the previous
 * refresh token stays valid) — run it only on a machine/account whose desktop
 * app can tolerate that, ideally a throwaway one.
 */
import { describe, expect, it } from 'vitest'
import {
  readQoderDesktopAuth,
  refreshQoderDeviceToken,
} from '../../src/providers/qoder/desktop-auth.ts'
import { createQoderTransport } from '../../src/providers/qoder/qoder/transport/index.ts'
import { QODER_CN_VARIANT } from '../../src/providers/qoder/variants.ts'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

const enabled = process.env['HUB_LIVE_QODER_DESKTOP'] === '1'

describe.skipIf(!enabled)('live qoder desktop login', () => {
  it('reads the local sign-in, rotates it and chats with a device token', async () => {
    const read = await readQoderDesktopAuth(QODER_CN_VARIANT, { env: {} })
    if (read.state !== 'found') {
      throw new Error(`no Qoder desktop sign-in on this machine (${read.state})`)
    }
    expect(read.credential.token.length).toBeGreaterThan(10)
    expect(read.credential.refreshToken.length).toBeGreaterThan(10)

    const rotated = await refreshQoderDeviceToken({
      region: 'china',
      refreshToken: read.credential.refreshToken,
    })
    expect(rotated.token).toMatch(/^dt-/u)
    expect(rotated.refreshToken).toMatch(/^drt-/u)
    expect(rotated.expiresAtMs).toBeGreaterThan(Date.now())

    // The plugin's rotation must not break the desktop app's own renewal: the
    // previous refresh token has to keep working. This is the load-bearing
    // assumption behind "the hub never modifies the Qoder app".
    const second = await refreshQoderDeviceToken({
      region: 'china',
      refreshToken: read.credential.refreshToken,
    })
    expect(second.token).toMatch(/^dt-/u)

    const transport = createQoderTransport({
      region: 'china',
      resolveAccessToken: async () => rotated.token,
      responseHeaderTimeoutMs: 60_000,
      streamIdleTimeoutMs: 120_000,
    })
    const models = await transport.discoverModels()
    expect(models.length).toBeGreaterThan(0)
    const model = models.find(entry => entry.id === 'auto') ?? models[0]!

    const messages: RequestMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: '只回复两个字：你好' }],
    }]
    let text = ''
    let finishReason: string | undefined
    for await (const chunk of transport.stream({
      provider: 'qoder',
      model: model.id,
      messages,
      maxTokens: 64,
    }, model)) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') finishReason = chunk.reason.kind
      if (text.length > 40) break
    }
    expect(finishReason).toBe('stop')
    expect(text.trim().length).toBeGreaterThan(0)
    process.stdout.write(`live qoder desktop: ${models.length} models, chat OK (${text.trim().slice(0, 8)}, ${finishReason})\n`)
  }, 120_000)
})
