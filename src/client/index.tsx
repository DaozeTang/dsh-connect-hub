/**
 * Browser half of dsh-connect-hub.
 *
 * One settings surface (the bundle page in Plugins) and one composer readout
 * registered in both composer seats. The readout itself decides which seat
 * draws, from a browser-local preference, so switching the seat never requires
 * re-registering a slot.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ComposerReadout } from './ComposerReadout.tsx'
import { HubSettingsPage } from './HubSettingsPage.tsx'
import { NS, en, zh } from './locales.ts'
import { insertStyles } from './styles.ts'

/** Stable browser-plugin name. */
export const name = 'dsh-connect-hub-client'

/** Services this half needs before it can register anything. */
export const inject = ['slots', 'locale']

/** The package name the plugin manager keys a bundle's configuration by. */
const BUNDLE_KEY = 'dsh-connect-hub'

/** The single id both composer seats register under. */
const READOUT_ID = 'connect-hub-readout'

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-connect-hub: locale')
  ctx.effect(() => insertStyles(), 'dsh-connect-hub: styles')

  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
    { name: 'plugins.bundle.config', key: BUNDLE_KEY, locale: NS },
    (props: PropsRuntime<'plugins.bundle.config'> & PropsLocale<typeof NS>) => (
      props.view === 'summary'
        ? props.t('summary')
        : <HubSettingsPage t={props.t} />
    ),
  ))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    { name: 'conversation.input.left', id: READOUT_ID, order: 60, locale: NS },
    (props: PropsRuntime<'conversation.input.left'> & PropsLocale<typeof NS>) => (
      <ComposerReadout {...props} seat="toolbar" />
    ),
  ))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: READOUT_ID, order: 30, locale: NS },
    (props: PropsRuntime<'conversation.input.dock'> & PropsLocale<typeof NS>) => (
      <ComposerReadout {...props} seat="dock" />
    ),
  ))
}
