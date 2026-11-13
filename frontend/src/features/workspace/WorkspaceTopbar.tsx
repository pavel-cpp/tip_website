import { AppLink } from '../../components/AppLink'
import { useI18n } from '../../i18n'
import { WorkspacePeople } from './WorkspacePeople'
import './workspace-topbar.css'

interface WorkspaceTopbarProps {
  projectId: string
  title: string
  followingId: string | null
  canFollow: boolean
  onSelectOnline: (id: string) => void
  onFollow: (id: string) => void
}

/** Project path and the colleagues who are in the project now, shown in the top bar while the workspace is open. */
export function WorkspaceTopbar({
  projectId,
  title,
  followingId,
  canFollow,
  onSelectOnline,
  onFollow,
}: WorkspaceTopbarProps) {
  const { t } = useI18n()
  return (
    <>
      <nav className="wsbar-crumbs" aria-label={t('workspace.crumbs')}>
        <AppLink to="/" className="wsbar-parent wsbar-hide-sm muted">
          {t('projects.title')}
        </AppLink>
        <span className="muted wsbar-slash wsbar-hide-sm" aria-hidden="true">
          /
        </span>
        <span className="wsbar-title" title={title} data-morph={`title:${projectId}`} data-morph-text="">
          {title}
        </span>
      </nav>
      <div className="wsbar-people">
        <div className="wsbar-group" data-testid="online-users">
          <WorkspacePeople
            followingId={followingId}
            canFollow={canFollow}
            onSelectOnline={onSelectOnline}
            onFollow={onFollow}
          />
        </div>
      </div>
    </>
  )
}
