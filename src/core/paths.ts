import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const HUB_DATA_DIR_NAME = '.dsh-connect-hub'
export const HUB_STATE_DIR_NAME = 'state'
export const HUB_DATA_DIR_ENV = 'DSH_CONNECT_HUB_DATA_DIR'

export interface HubPaths {
  home: string
  profileDir?: string
  dataDir: string
  stateDir: string
}

export function resolveHubPaths(options: {
  profileDir?: string | undefined
  home?: string | undefined
  override?: string | undefined
}): HubPaths {
  const home = options.home ?? resolveDshHome()
  const override = options.override ?? process.env[HUB_DATA_DIR_ENV]
  const base = override !== undefined && override.trim() !== ''
    ? override
    : options.profileDir !== undefined && options.profileDir.trim() !== ''
      ? join(options.profileDir, HUB_DATA_DIR_NAME)
      : join(home, HUB_DATA_DIR_NAME)
  const paths: HubPaths = {
    home,
    dataDir: base,
    stateDir: join(base, HUB_STATE_DIR_NAME),
  }
  if (options.profileDir !== undefined) paths.profileDir = options.profileDir
  return paths
}

export function profileDirOf(ctx: { get?(name: string): unknown }): string | undefined {
  const value = ctx.get?.('profileContext') as { dir?: unknown } | undefined
  return typeof value?.dir === 'string' && value.dir.trim() !== '' ? value.dir : undefined
}
