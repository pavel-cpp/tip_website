import { AppLink } from '../../components/AppLink'
import { AvatarStack } from '../../components/Avatar'
import { useI18n } from '../../i18n'
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
  return (
    <>
      <nav className="wsbar-crumbs" aria-label={t('workspace.crumbs')}>
        <AppLink to="/" className="wsbar-parent muted">
          {t('projects.title')}
        </AppLink>
        <span className="muted wsbar-slash" aria-hidden="true">
          /
        </span>
        <span className="wsbar-title" title={title}>
          {title}
        </span>
      </nav>
      <div className="wsbar-people">
        {hasOnline && (
          <div className="wsbar-group" data-testid="online-users">
            <span className="wsbar-label">{t('workspace.people.online')}</span>
            <OnlineAvatars onSelect={onSelectPeer} activeId={watchedId} />
          </div>
        )}
        {contributors.length > 0 && (
          <div className="wsbar-group wsbar-contrib">
            <span className="wsbar-label">{t('workspace.people.contributors')}</span>
            <AvatarStack users={contributors.map((c) => ({ ...c, avatar: null }))} />
          </div>
        )}
      </div>
    </>
  )
}
