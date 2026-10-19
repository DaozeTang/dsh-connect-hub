import { describe, expect, it } from 'vitest'
import {
  REGION_GATEWAYS,
  regionOfCredential,
  regionOfEdition,
  regionOfHost,
  regionOfUserRegion,
} from '../../../src/providers/trae/region.ts'

describe('regionOfEdition', () => {
  it('maps the four editions onto the two routing buckets', () => {
    expect(regionOfEdition('cn')).toBe('cn')
    expect(regionOfEdition('solo')).toBe('cn')
    expect(regionOfEdition('sg')).toBe('ai')
    expect(regionOfEdition('solo-sg')).toBe('ai')
  })
})

describe('regionOfUserRegion', () => {
  it('reads the desktop object shape {region: "CN"|"SG"}', () => {
    expect(regionOfUserRegion({ region: 'CN', _aiRegion: 'CN' })).toBe('cn')
    expect(regionOfUserRegion({ region: 'SG', _aiRegion: 'SG' })).toBe('ai')
  })

  it('accepts bare strings and is case-blind', () => {
    expect(regionOfUserRegion('CN')).toBe('cn')
    expect(regionOfUserRegion('sg')).toBe('ai')
    expect(regionOfUserRegion('  ai ')).toBe('ai')
  })

  it('returns undefined for absent or unrecognized claims', () => {
    expect(regionOfUserRegion(undefined)).toBeUndefined()
    expect(regionOfUserRegion('')).toBeUndefined()
    expect(regionOfUserRegion('eu')).toBeUndefined()
    expect(regionOfUserRegion({})).toBeUndefined()
    expect(regionOfUserRegion([1])).toBeUndefined()
  })
})

describe('regionOfHost', () => {
  it('routes trae.ai hosts to ai and trae.cn hosts to cn', () => {
    expect(regionOfHost('https://growsg-normal.trae.ai')).toBe('ai')
    expect(regionOfHost('coresg-normal.trae.ai')).toBe('ai')
    expect(regionOfHost('https://api.trae.cn')).toBe('cn')
    expect(regionOfHost('https://www.trae.com.cn')).toBe('cn')
  })

  it('returns undefined for empty or foreign hosts', () => {
    expect(regionOfHost(undefined)).toBeUndefined()
    expect(regionOfHost('')).toBeUndefined()
    expect(regionOfHost('https://example.com')).toBeUndefined()
  })
})

describe('regionOfCredential', () => {
  it('prefers the userRegion claim over host and edition', () => {
    expect(regionOfCredential({ edition: 'sg', host: 'https://api-sg-central.trae.ai', userRegion: 'SG' })).toBe('ai')
    expect(regionOfCredential({ edition: 'solo-sg', host: 'https://growsg-normal.trae.ai', userRegion: 'cn' })).toBe('cn')
  })

  it('falls back to the host suffix, then the edition label', () => {
    expect(regionOfCredential({ edition: 'cn', host: 'https://api-sg-central.trae.ai' })).toBe('ai')
    expect(regionOfCredential({ edition: 'solo-sg', host: 'https://api.trae.cn' })).toBe('cn')
    expect(regionOfCredential({ edition: 'solo' })).toBe('cn')
    expect(regionOfCredential({ edition: 'solo-sg' })).toBe('ai')
  })
})

describe('REGION_GATEWAYS', () => {
  it('keeps one verified gateway per region and never shares a chat base', () => {
    expect(REGION_GATEWAYS.cn.chat).toBe('https://trae-api-cn.mchost.guru')
    expect(REGION_GATEWAYS.ai.chat).toBe('https://coresg-normal.trae.ai')
    expect(REGION_GATEWAYS.cn.remote).toContain('solo.trae.cn')
    expect(REGION_GATEWAYS.ai.remote).toContain('coresg-normal.trae.ai')
    expect(REGION_GATEWAYS.cn.chat).not.toBe(REGION_GATEWAYS.ai.chat)
  })
})
