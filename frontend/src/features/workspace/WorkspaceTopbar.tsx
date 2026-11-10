import { AppLink } from '../../components/AppLink'
import { AvatarStack } from '../../components/Avatar'
import { useI18n } from '../../i18n'
import { useRealtime } from '../realtime/RealtimeProvider'
import { OnlineAvatars } from '../realtime/RealtimeStatus'
import './workspace-topbar.css'

interface WorkspaceTopbarProps {
  title: string
  contributors: { id: string; displayName: string; color: string }[]
  hasOnline: boolean
  watchedId: string | null
  onSelectPeer: (id: string) => void
}

/** Project path and the colleagues online, shown in the top bar while the workspace is open. */
export function WorkspaceTopbar({
  title,
  contributors,
  hasOnline,
  watchedId,
  onSelectPeer,
}: WorkspaceTopbarProps) {
  const { t } = useI18n()
  const rt = useRealtime()
  const onlineIds = new Set(
    (rt?.snapshot.peers ?? []).filter((p) => p.id !== rt?.snapshot.you).map((p) => p.id),
  )
  // A member who is online is shown once, in the green group.
  const offline = contributors.filter((c) => !onlineIds.has(c.id))
  return (
    <>
      <nav className="wsbar-crumbs" aria-label={t('workspace.crumbs')}>
        <AppLink to="/" className="wsbar-parent wsbar-hide-sm muted">
          {t('projects.title')}
        </AppLink>
        <span className="muted wsbar-slash wsbar-hide-sm" aria-hidden="true">
          /
        </span>
        <span className="wsbar-title" title={title}>
          {title}
        </span>
      </nav>
      <div className="wsbar-people">
        {(hasOnline || offline.length > 0) && (
          <div className="wsbar-group" data-testid="online-users">
            <span className="wsbar-label">{t('workspace.people.contributors')}</span>
            {/* Colleagues online now come first: green ring, a click jumps to what they are editing. */}
            {hasOnline && <OnlineAvatars onSelect={onSelectPeer} activeId={watchedId} />}
            {offline.length > 0 && (
              <AvatarStack users={offline.map((c) => ({ ...c, avatar: null }))} max={hasOnline ? 3 : 4} />
            )}
          </div>
        )}
      </div>
    </>
  )
}
