/**
 * Account/credential identity tracking for asynchronous reads.
 *
 * Network answers can land after the active account, PAT or region changed. A
 * page that already switched accounts must never be shown the previous one's
 * quota, so asynchronous work captures a stamp BEFORE it starts and publishes
 * only while {@link IdentityGuard.isCurrent} still holds. The generation is
 * bumped on every transition, which also covers an A -> B -> A switch that the
 * identity string alone could not see.
 */

/** A generation-stamped identity captured before asynchronous work starts. */
export interface IdentityStamp {
  /** The account/credential identity active when the stamp was taken. */
  readonly identity: string | undefined
  /** Monotonic generation counter; changes on every identity transition. */
  readonly generation: number
}

export class IdentityGuard {
  private identity: string | undefined
  private generation = 0

  constructor(identity?: string) {
    this.identity = identity
  }

  /** The identity currently in effect. */
  current(): string | undefined {
    return this.identity
  }

  /**
   * Update the active identity. Returns true when it changed (which also bumps
   * the generation); repeated updates with the same identity are no-ops so a
   * poll does not invalidate work that is still current.
   */
  update(identity: string | undefined): boolean {
    if (identity === this.identity) return false
    this.identity = identity
    this.generation += 1
    return true
  }

  /** Capture the identity and generation that asynchronous work may publish under. */
  capture(): IdentityStamp {
    return { identity: this.identity, generation: this.generation }
  }

  /** Whether a stamp still describes the active identity. */
  isCurrent(stamp: IdentityStamp): boolean {
    return stamp.generation === this.generation && stamp.identity === this.identity
  }
}
