/** Presentation preferences: which composer seat draws the readout. */

import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectHubTranslate } from '../format.ts'
import { useClientPreferences } from '../hooks.ts'
import { IconSliders } from '../icons.tsx'
import { clientPreferences } from '../prefs.ts'
import type { ComposerSeat } from '../prefs.ts'
import { SectionCard } from '../ui.tsx'

/** Browser-local preference card; independent of the shown provider. */
export function PreferencesSection({ t }: { t: ConnectHubTranslate }): JSX.Element {
  const preferences = useClientPreferences()
  return (
    <SectionCard title={t('sectionPreferences')} icon={<IconSliders size={14} />}>
      <div className="ch-pref-row">
        <div className="ch-pref-copy">
          <div className="ch-pref-title">{t('composerSeatLabel')}</div>
          <div className="ch-caption">{t('composerSeatHint')}</div>
        </div>
        <SegmentedControl<ComposerSeat>
          id="ch-composer-seat"
          value={preferences.seat}
          label={t('composerSeatLabel')}
          options={[
            { value: 'toolbar', label: t('composerSeatToolbar') },
            { value: 'dock', label: t('composerSeatDock') },
          ]}
          onChange={(seat) => clientPreferences.setSeat(seat)}
        />
      </div>
    </SectionCard>
  )
}
