/**
 * The two WorkBuddy desktop products served by this provider family.
 *
 * Both are the same Electron client framework in different regions and share
 * one auth directory, differing only by file basename, endpoint identity, and
 * display name. Each difference is data in this module, so no other module
 * branches on region.
 */

import type { SecretSlot } from '../../core/vault.ts'
import type { ProviderId, Region } from '../../shared/contracts.ts'

/** One WorkBuddy product variant. */
export interface WorkBuddyVariant {
  /** Provider route registered with the harness, e.g. `workbuddy-ai`. */
  id: ProviderId
  /** Model-group heading and card title stem. */
  displayName: string
  /** Desktop app name as users know it, for diagnostics and error copy. */
  appName: string
  /** Which upstream region this variant's credentials must belong to. */
  region: Region
  /** Env var overriding the desktop auth-file location. */
  env: string
  /** How this product's Electron helper is identified and located. */
  electron: WorkBuddyElectronProduct
  /** Basename of the desktop app's own auth file in the shared auth directory. */
  desktopFilename: string
  /** Vault slot holding the hub-owned refreshed credential copy. */
  slot: SecretSlot
}

/** How one product's Electron key helper is identified on each platform. */
export interface WorkBuddyElectronProduct {
  /** Product name for helper diagnostics and error copy. */
  productName: string
  /** Env var naming an explicit Electron binary for this product alone. */
  envVar: string
  /** macOS identity and default install layout. */
  macOS: {
    bundleId: string
    defaultPath: string
  }
  /** Windows identity from the uninstall registry and the exe it names. */
  windows: {
    displayNamePattern: RegExp
    exeBasename: string
    defaultPathSegments?: readonly string[]
  }
}

/** macOS bundle → Electron executable inside it. */
function macBundle(bundleId: string, appName: string): WorkBuddyElectronProduct['macOS'] {
  return { bundleId, defaultPath: `/Applications/${appName}.app/Contents/MacOS/Electron` }
}

/** Windows uninstall identity plus the optional measured default location. */
function windowsProduct(
  displayNamePattern: RegExp,
  exeBasename: string,
  defaultPathSegments?: readonly string[],
): WorkBuddyElectronProduct['windows'] {
  return {
    displayNamePattern,
    exeBasename,
    ...(defaultPathSegments === undefined ? {} : { defaultPathSegments }),
  }
}

/** Assemble one product's Electron resolution profile. */
function electronProduct(options: {
  productName: string
  envVar: string
  bundleId: string
  appName: string
  windows: WorkBuddyElectronProduct['windows']
}): WorkBuddyElectronProduct {
  return {
    productName: options.productName,
    envVar: options.envVar,
    macOS: macBundle(options.bundleId, options.appName),
    windows: options.windows,
  }
}

/** The CN product descriptor. */
const CN: WorkBuddyVariant = {
  id: 'workbuddy',
  displayName: 'WorkBuddy',
  appName: 'WorkBuddy',
  region: 'cn',
  env: 'DSH_CONNECT_HUB_WORKBUDDY_AUTH_FILE',
  electron: electronProduct({
    productName: 'WorkBuddy',
    envVar: 'DSH_CONNECT_HUB_WORKBUDDY_ELECTRON_BIN',
    bundleId: 'com.tencent.workbuddy.mac',
    appName: 'WorkBuddy',
    windows: windowsProduct(
      /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
      'workbuddy.exe',
      ['Programs', 'WorkBuddy', 'WorkBuddy.exe'],
    ),
  }),
  desktopFilename: 'workbuddy-desktop.info',
  slot: 'workbuddy-cn',
}

/** The international product descriptor. */
const AI: WorkBuddyVariant = {
  id: 'workbuddy-ai',
  displayName: 'WorkBuddy AI',
  appName: 'WorkBuddy AI',
  region: 'global',
  env: 'DSH_CONNECT_HUB_WORKBUDDY_AI_AUTH_FILE',
  electron: electronProduct({
    productName: 'WorkBuddy AI',
    envVar: 'DSH_CONNECT_HUB_WORKBUDDY_AI_ELECTRON_BIN',
    bundleId: 'com.workbuddy.workbuddy-ai',
    appName: 'WorkBuddy AI',
    // Registry-only on Windows: the international app has no measured default
    // install location, so no default path segment is guessed for it.
    windows: windowsProduct(
      /^WorkBuddy AI(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
      'workbuddyai.exe',
    ),
  }),
  desktopFilename: 'workbuddy-desktop-ai.info',
  slot: 'workbuddy-ai',
}

/** The CN variant. */
export const CN_VARIANT: WorkBuddyVariant = CN

/** The international variant. */
export const AI_VARIANT: WorkBuddyVariant = AI

/**
 * The Electron profile a variant resolves with. A descriptor built outside this
 * module keeps working: its own profile wins when present, otherwise the id
 * selects the product and an unknown id falls back to CN.
 */
export function electronProfileFor(
  variant: Pick<WorkBuddyVariant, 'id' | 'electron'> | undefined,
): WorkBuddyElectronProduct {
  if (variant?.electron !== undefined) return variant.electron
  return variant?.id === AI.id ? AI.electron : CN.electron
}
