import type { BilingualText, ProviderId, Region } from '../../shared/contracts.ts'
import type { SecretSlot } from '../../core/vault.ts'
import type { QoderRegion } from './qoder/region.ts'

/**
 * Where the region's Qoder desktop app keeps its signed-in account. The hub
 * reads that file; it never writes it. `dataDirectory` is the app's Electron
 * `userData` directory name, `appName` is the Electron application name that
 * keys the OS credential store (the Keychain service on macOS), and
 * `authFileEnv` overrides the location for unusual installs.
 */
export interface QoderDesktopApp {
  dataDirectory: string
  appName: string
  authFileEnv: string
}

/** Everything that distinguishes the two Qoder deployments in the hub. */
export interface QoderVariant {
  /** Provider route registered with the harness. */
  id: ProviderId
  /** Region marker used by the hub's provider list. */
  region: Region
  /** Service deployment the transport talks to. */
  upstreamRegion: QoderRegion
  /** Human-readable deployment name. */
  displayName: string
  /** Bilingual provider label shown in the settings surface. */
  label: BilingualText
  /** Vault slot that stores this deployment's credential. */
  slot: SecretSlot
  /** The desktop app whose sign-in this route can read automatically. */
  desktop: QoderDesktopApp
}

/**
 * File name of the desktop app's encrypted sign-in record. The number is part
 * of the app's on-disk format and is likely to change with the app, so the
 * reader probes the known names instead of assuming this one forever.
 */
export const QODER_DESKTOP_AUTH_FILENAMES: readonly string[] = ['auth.v1.dat']

/** Descriptions of the two deployments, keyed by their service region. */
const VARIANT_DEFINITIONS: Record<QoderRegion, QoderVariant> = {
  china: {
    id: 'qoder',
    region: 'cn',
    upstreamRegion: 'china',
    displayName: 'Qoder',
    label: { zh: 'Qoder', en: 'Qoder' },
    slot: 'qoder-cn',
    desktop: {
      dataDirectory: 'com.qodercn.app.stable',
      appName: 'Qoder CN App',
      authFileEnv: 'DSH_CONNECT_HUB_QODER_CN_AUTH_FILE',
    },
  },
  global: {
    id: 'qoder-global',
    region: 'global',
    upstreamRegion: 'global',
    displayName: 'Qoder Global',
    label: { zh: 'Qoder 国际版', en: 'Qoder Global' },
    slot: 'qoder-global',
    desktop: {
      dataDirectory: 'com.qoder.app.stable',
      appName: 'Qoder App',
      authFileEnv: 'DSH_CONNECT_HUB_QODER_GLOBAL_AUTH_FILE',
    },
  },
}

/** The China-region provider route. */
export const QODER_CN_VARIANT: QoderVariant = VARIANT_DEFINITIONS.china

/** The international provider route. */
export const QODER_GLOBAL_VARIANT: QoderVariant = VARIANT_DEFINITIONS.global
