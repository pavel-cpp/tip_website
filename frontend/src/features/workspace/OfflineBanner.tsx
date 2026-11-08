import { Icon } from '../../components/Icon'
import { useI18n } from '../../i18n'
import { useRealtime } from '../realtime/RealtimeProvider'

/** True while the live connection is down (or has not been established yet and failed). */
export function useConnectionDown(): 'offline' | 'reconnecting' | null {
  const state = useRealtime()?.state
  return state === 'offline' || state === 'reconnecting' ? state : null
}

/** Banner under the workspace header that explains that edits are kept and sent later. */
export function OfflineBanner({ down }: { down: 'offline' | 'reconnecting' | null }) {
  const { t } = useI18n()
  if (!down) return null
  return (
    <p className="ws-banner ws-offline" data-state={down} role="status">
      <Icon name="alert" size={16} />
      {t(down === 'offline' ? 'workspace.offline.banner' : 'workspace.offline.reconnecting')}
    </p>
  )
}
