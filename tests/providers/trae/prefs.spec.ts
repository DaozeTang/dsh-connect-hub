import { describe, expect, it } from 'vitest'
import { TRAE_CHECKIN_LOG_LIMIT, TRAE_DEFAULT_CHECKIN_MINUTE } from '../../../src/providers/trae/constants.ts'
import {
  defaultTraePrefs,
  effectiveModelEnabled,
  enabledModelIds,
  parseTraePrefs,
  withCheckinLog,
} from '../../../src/providers/trae/prefs.ts'

describe('Trae preferences', () => {
  it('starts with an empty override set, no probe consent, and a daily check-in schedule', () => {
    expect(defaultTraePrefs()).toEqual({
      version: 1,
      modelEnabled: {},
      useMaxContext: false,
      probeConsent: false,
      probes: {},
      checkin: { enabled: true, minute: TRAE_DEFAULT_CHECKIN_MINUTE, log: [] },
    })
  })

  it('tolerates any stored shape without throwing', () => {
    expect(parseTraePrefs(undefined)).toEqual(defaultTraePrefs())
    expect(parseTraePrefs('garbage')).toEqual(defaultTraePrefs())
    expect(parseTraePrefs({ modelEnabled: { a: true, b: 'yes', c: false } }).modelEnabled).toEqual({ a: true, c: false })
  })

  it('parses stored selections, schedules, probes and the bounded log', () => {
    const prefs = parseTraePrefs({
      version: 1,
      selectedAccountId: 'acc-1',
      modelEnabled: { 'glm-5.2': false },
      useMaxContext: true,
      probeConsent: true,
      probes: {
        'glm-5.2': { state: 'ok', efforts: ['low', 'high'], at: 5 },
        broken: { state: 'nope' },
      },
      checkin: {
        enabled: false,
        minute: 1234,
        lastRunAt: 77,
        log: [
          { at: 1, ok: true, message: 'ok' },
          { at: 0, ok: true, message: 'invalid timestamp' },
        ],
      },
    })
    expect(prefs.selectedAccountId).toBe('acc-1')
    expect(prefs.useMaxContext).toBe(true)
    expect(prefs.probeConsent).toBe(true)
    expect(prefs.probes['glm-5.2']).toEqual({ modelId: 'glm-5.2', state: 'ok', efforts: ['low', 'high'], at: 5 })
    expect(prefs.probes['broken']).toBeUndefined()
    expect(prefs.checkin).toEqual({ enabled: false, minute: 1234, lastRunAt: 77, log: [{ at: 1, ok: true, message: 'ok' }] })
  })

  it('clamps an out-of-range minute back to the default', () => {
    expect(parseTraePrefs({ checkin: { minute: 5000 } }).checkin.minute).toBe(TRAE_DEFAULT_CHECKIN_MINUTE)
    expect(parseTraePrefs({ checkin: { minute: -1 } }).checkin.minute).toBe(TRAE_DEFAULT_CHECKIN_MINUTE)
    expect(parseTraePrefs({ checkin: { minute: 0 } }).checkin.minute).toBe(0)
  })

  it('keeps the check-in log bounded', () => {
    let prefs = defaultTraePrefs()
    for (let index = 0; index < TRAE_CHECKIN_LOG_LIMIT + 5; index += 1) {
      prefs = withCheckinLog(prefs, { at: index, ok: true, message: `row ${String(index)}` })
    }
    expect(prefs.checkin.log).toHaveLength(TRAE_CHECKIN_LOG_LIMIT)
    expect(prefs.checkin.log[0]?.at).toBe(5)
  })

  it('reads model visibility with enabled-by-default semantics', () => {
    const prefs = defaultTraePrefs()
    expect(effectiveModelEnabled(prefs, 'new-model')).toBe(true)
    prefs.modelEnabled['new-model'] = false
    expect(effectiveModelEnabled(prefs, 'new-model')).toBe(false)
    expect(enabledModelIds(prefs, [{ id: 'new-model' }, { id: 'other' }])).toEqual(['other'])
  })
})
