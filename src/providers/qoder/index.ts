import type { ProviderFactory } from '../../core/types.ts'
import { createQoderRuntime } from './provider.ts'
import { QODER_CN_VARIANT, QODER_GLOBAL_VARIANT } from './variants.ts'

/**
 * Both Qoder deployments as independent provider routes: the China edition
 * (`qoder`) and the international one (`qoder-global`). Each owns its vault
 * slot, catalog, usage cache and check-in schedule, so one being signed out or
 * unreachable never blocks the other.
 */
export const createQoderProviders: ProviderFactory = (deps) => [
  createQoderRuntime(deps, QODER_CN_VARIANT),
  createQoderRuntime(deps, QODER_GLOBAL_VARIANT),
]
