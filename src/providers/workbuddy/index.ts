/**
 * WorkBuddy provider family: the CN `workbuddy` route and the international
 * `workbuddy-ai` route.
 *
 * Both are assembled by the same runtime factory and differ only in their
 * variant descriptor, so neither route's credential state or catalog fetch can
 * stop the other from registering. A machine with only one of the desktop apps
 * installed simply sees the other route without models.
 */

import type { ProviderFactory } from '../../core/types.ts'
import { createWorkBuddyRuntime } from './runtime.ts'
import { AI_VARIANT, CN_VARIANT } from './variants.ts'

export const createWorkBuddyProviders: ProviderFactory = (deps) => [
  createWorkBuddyRuntime(deps, CN_VARIANT),
  createWorkBuddyRuntime(deps, AI_VARIANT),
]
