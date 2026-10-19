import { describe, expect, it } from 'vitest'
import {
  canonicalRefreshHost,
  normalizeTraeGatewayHost,
  refreshHostOf,
  regionOfRefreshHost,
} from '../../../src/providers/trae/hosts.ts'

describe('gateway host normalization', () => {
  it('accepts known Trae HTTPS gateways and normalizes them to an origin', () => {
    expect(normalizeTraeGatewayHost('https://api.trae.cn')).toEqual({ host: 'https://api.trae.cn', region: 'cn' })
    expect(normalizeTraeGatewayHost('https://www.trae.com.cn/')).toEqual({ host: 'https://www.trae.com.cn', region: 'cn' })
    expect(normalizeTraeGatewayHost('https://api-sg-central.trae.ai')).toEqual({ host: 'https://api-sg-central.trae.ai', region: 'ai' })
    expect(normalizeTraeGatewayHost('https://api.trae.cn:443')).toEqual({ host: 'https://api.trae.cn', region: 'cn' })
    expect(regionOfRefreshHost('https://growsg-normal.trae.ai')).toBe('ai')
  })

  it('refuses plaintext, foreign, credential-bearing and non-standard-port hosts', () => {
    expect(normalizeTraeGatewayHost('http://api.trae.cn')).toBeUndefined()
    expect(normalizeTraeGatewayHost('https://evil.example')).toBeUndefined()
    expect(normalizeTraeGatewayHost('https://api.trae.cn.attacker.example')).toBeUndefined()
    expect(normalizeTraeGatewayHost('https://user:pass@api.trae.cn')).toBeUndefined()
    expect(normalizeTraeGatewayHost('https://api.trae.cn:8443')).toBeUndefined()
    expect(normalizeTraeGatewayHost('not a url')).toBeUndefined()
    expect(normalizeTraeGatewayHost('')).toBeUndefined()
    expect(normalizeTraeGatewayHost(undefined)).toBeUndefined()
  })

  it('knows one canonical HTTPS refresh host per region', () => {
    expect(canonicalRefreshHost('cn')).toBe('https://api.trae.cn')
    expect(canonicalRefreshHost('ai')).toBe('https://growsg-normal.trae.ai')
  })
})

describe('refreshHostOf', () => {
  it('keeps a validated stored host (including legacy aliases) verbatim as an origin', () => {
    expect(refreshHostOf({ host: 'https://api.trae.cn', userRegion: 'CN', edition: 'solo' })).toBe('https://api.trae.cn')
    expect(refreshHostOf({ host: 'https://www.trae.cn/', userRegion: 'CN', edition: 'cn' })).toBe('https://www.trae.cn')
    expect(refreshHostOf({ host: 'https://api-sg-central.trae.ai', userRegion: 'SG', edition: 'sg' })).toBe('https://api-sg-central.trae.ai')
  })

  it('falls back to the canonical region gateway for a host-less legacy credential', () => {
    expect(refreshHostOf({ host: '', userRegion: 'CN', edition: 'cn' })).toBe('https://api.trae.cn')
    expect(refreshHostOf({ host: '   ', edition: 'solo-sg' })).toBe('https://growsg-normal.trae.ai')
  })

  it('refuses a non-HTTPS or unknown host before any network call', () => {
    expect(() => refreshHostOf({ host: 'http://api.trae.cn', userRegion: 'CN', edition: 'cn' })).toThrow(/HTTPS Trae 网关/)
    expect(() => refreshHostOf({ host: 'https://evil.example', userRegion: 'CN', edition: 'cn' })).toThrow(/HTTPS Trae 网关/)
    expect(() => refreshHostOf({ host: 'http://evil.example', userRegion: 'CN', edition: 'cn' })).toThrow(/HTTPS Trae 网关/)
  })

  it('refuses a host that contradicts the credential region claim', () => {
    expect(() => refreshHostOf({ host: 'https://api.trae.cn', userRegion: 'SG', edition: 'sg' })).toThrow(/区域不一致/)
    expect(() => refreshHostOf({ host: 'https://coresg-normal.trae.ai', userRegion: 'CN', edition: 'cn' })).toThrow(/区域不一致/)
  })
})
