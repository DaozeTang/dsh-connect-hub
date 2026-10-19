/** Generation-stamped identity: the primitive behind the account-mixing fixes. */

import { describe, expect, it } from 'vitest'
import { IdentityGuard } from '../../src/core/identity.ts'

describe('IdentityGuard', () => {
  it('changes generation whenever the identity moves', () => {
    const guard = new IdentityGuard('a')
    const first = guard.capture()
    expect(guard.isCurrent(first)).toBe(true)

    expect(guard.update('b')).toBe(true)
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.current()).toBe('b')

    // Re-setting the same identity is a no-op, so a poll cannot invalidate
    // work that still belongs to the current account.
    expect(guard.update('b')).toBe(false)
    expect(guard.isCurrent(guard.capture())).toBe(true)
  })

  it('distinguishes an A -> B -> A round trip from an unchanged account', () => {
    const guard = new IdentityGuard('a')
    const before = guard.capture()
    guard.update('b')
    guard.update('a')
    expect(guard.isCurrent(before)).toBe(false)
    expect(before.identity).toBe('a')
  })

  it('keeps a captured stamp frozen across later transitions', () => {
    const guard = new IdentityGuard('a')
    const before = guard.capture()
    guard.update('b')
    guard.update('a')
    // The stamp is a value snapshot, not a live view: even returning to the
    // same identity cannot make the earlier read publishable.
    expect(before).toEqual({ identity: 'a', generation: 0 })
    expect(guard.isCurrent(before)).toBe(false)
    expect(guard.current()).toBe('a')
  })
})
