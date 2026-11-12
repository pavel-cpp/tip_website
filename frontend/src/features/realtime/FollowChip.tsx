import type { CSSProperties } from 'react'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { useI18n } from '../../i18n'
import type { PeerStatus } from './follow'
import type { Peer } from './protocol'
import './realtime.css'

interface FollowChipProps {
  peer: Peer
  status: PeerStatus
  /** Number shown for the row the colleague is on; null when that row is gone or unknown. */
  rowNumber: number | null
  following: boolean
  onToggleFollow: () => void
  onClose: () => void
}

/** "Aziza is editing the name of row 12", with the Follow toggle and a close button. */
export function FollowChip({ peer, status, rowNumber, following, onToggleFollow, onClose }: FollowChipProps) {
  const { t } = useI18n()
  const vars = { name: peer.displayName, number: rowNumber ?? '' }
  let text: string
  if (rowNumber === null) text = t('realtime.follow.idle', vars)
  else if (status.editing) {
    text =
      status.field === 'name'
        ? t('realtime.follow.editingName', vars)
        : status.field === 'phone'
          ? t('realtime.follow.editingPhone', vars)
          : t('realtime.follow.editingRow', vars)
  } else text = t('realtime.follow.viewing', vars)

  return (
    <div
      className="rt-chip"
      style={{ '--peer': peer.color } as CSSProperties}
      data-following={following || undefined}
    >
      <span className="rt-chip-dot" aria-hidden="true" />
      <span className="rt-chip-text" role="status" data-testid="follow-status">
        {text}
      </span>
      <Button
        size="sm"
        variant={following ? 'primary' : 'secondary'}
        aria-pressed={following}
        onClick={onToggleFollow}
      >
        <Icon name="eye" size={16} />
        {following ? t('realtime.follow.stop') : t('realtime.follow.start')}
      </Button>
      <Button size="sm" variant="ghost" iconOnly aria-label={t('realtime.follow.close')} onClick={onClose}>
        <Icon name="x" size={16} />
      </Button>
    </div>
  )
}
