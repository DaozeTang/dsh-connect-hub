import type { ProviderFactory } from '../../core/types.ts'
import { TRAE_PROVIDER_LABELS, TRAE_PROVIDER_IDS } from './constants.ts'
import { TraeProviderRuntime } from './runtime.ts'

/**
 * Two parallel provider stacks, one per Trae region. Each owns its credential
 * slot, loopback shim, model catalog and check-in schedule, so a domestic and
 * an international account serve simultaneously.
 */
export const createTraeProviders: ProviderFactory = (deps) => [
  new TraeProviderRuntime({
    deps,
    region: 'cn',
    providerId: TRAE_PROVIDER_IDS.cn,
    label: TRAE_PROVIDER_LABELS.cn,
  }),
  new TraeProviderRuntime({
    deps,
    region: 'ai',
    providerId: TRAE_PROVIDER_IDS.ai,
    label: TRAE_PROVIDER_LABELS.ai,
  }),
]
