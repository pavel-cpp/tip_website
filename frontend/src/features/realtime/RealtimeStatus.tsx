import { useI18n } from '../../i18n'
import { useRealtime } from './RealtimeProvider'
import './realtime.css'

/** Quiet pill that only appears while the connection is down. */
export function ConnectionBadge() {
  const rt = useRealtime()
  const { t } = useI18n()
  const state = rt?.state
  if (state !== 'reconnecting' && state !== 'offline') return null
  return (
    <span className="rt-conn" data-state={state} role="status">
      <span className="rt-conn-dot" aria-hidden="true" />
      {t(state === 'offline' ? 'realtime.conn.offline' : 'realtime.conn.reconnecting')}
    </span>
  )
}
