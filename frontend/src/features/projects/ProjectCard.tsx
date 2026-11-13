import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { AppLink } from '../../components/AppLink'
import { AvatarStack } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { Icon, type IconName } from '../../components/Icon'
import { Menu, type MenuItem } from '../../components/Menu'
import { useI18n } from '../../i18n'
import { cx } from '../../lib/cx'
import type { ProjectCardData } from './api'
import { gradientFor, type ProjectAction } from './logic'
import { useAuthedImage } from './useAuthedImage'
import './projects.css'

const ACTION_ICON: Record<ProjectAction, IconName> = {
  settings: 'pencil',
  moveUp: 'list',
  moveDown: 'list',
  finish: 'check',
  reopen: 'check',
  delete: 'trash',
}

/** Online avatars shown on a card before the "+N" chip. */
export const ONLINE_SHOWN = 3

/**
 * Width of the avatars + menu cluster on the footer row (px), so the caption on the left never runs
 * under it. Mirrors the CSS: 32px button, 20px per overlapping 26px avatar plus 6px, 8px gap.
 */
export function asideWidth(onlineCount: number, hasMenu: boolean): number {
  const chips = Math.min(onlineCount, ONLINE_SHOWN) + (onlineCount > ONLINE_SHOWN ? 1 : 0)
  const online = onlineCount > 0 ? 20 * chips + 6 : 0
  return (hasMenu ? 32 : 0) + online + (hasMenu && online > 0 ? 8 : 0)
}

/** True once the element has been near the viewport; thumbnails are fetched lazily. */
function useSeen(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true)
        io.disconnect()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  return [ref, seen]
}

interface ProjectCardProps {
  project: ProjectCardData
  /** Position in the list; currently unused since the entrance stagger was dropped. */
  index: number
  actions: ProjectAction[]
  onAction: (action: ProjectAction, project: ProjectCardData) => void
  /** Pointer handlers from useProjectDnd; present when the user may drag cards. */
  dragProps?: Record<string, unknown>
  dragging?: boolean
}

export function ProjectCard({ project, actions, onAction, dragProps, dragging }: ProjectCardProps) {
  const { t } = useI18n()
  const [ref, seen] = useSeen()
  const image = useAuthedImage(project.image?.thumbUrl, seen)
  const finished = project.status === 'finished'

  const items: MenuItem[] = actions.map((action, i) => ({
    id: action,
    label: t(`projects.menu.${action}`),
    icon: ACTION_ICON[action],
    danger: action === 'delete',
    separatorBefore: action === 'delete' && i > 0,
    onSelect: () => onAction(action, project),
  }))

  const background = image ? `left top / cover url(${image})` : gradientFor(project.id)
  const online = project.online
  const names = online.map((u) => u.displayName).join(', ')

  return (
    <div
      ref={ref}
      className={cx(
        'project-card',
        finished && 'is-finished',
        dragProps && 'is-draggable',
        dragging && 'is-dragging',
      )}
      data-flip-id={project.id}
      data-morph={`hero:${project.id}`}
      style={
        {
          '--aside-w': `${asideWidth(online.length, items.length > 0) + 8}px`,
        } as CSSProperties
      }
      {...dragProps}
    >
      <AppLink to={`/projects/${project.id}`} className="project-card-link" draggable={false}>
        {/* The picture stays clean: title, status and actions live on the solid strip below it. */}
        <span
          className="project-card-thumb"
          style={{ background }}
          data-morph={`ticket:${project.id}`}
          aria-hidden="true"
        />
        <span className="project-card-body">
          <span className="project-card-title" data-morph={`title:${project.id}`} data-morph-text="">
            {project.title}
          </span>
          <span className="project-card-meta">
            {finished && <span className="project-card-status">{t('projects.card.finished')}</span>}
            <span className="project-card-count">
              {t('projects.card.participants', { count: project.participantCount })}
            </span>
          </span>
        </span>
      </AppLink>
      <div className="project-card-aside">
        {online.length > 0 && (
          <span
            className="project-card-online"
            role="img"
            aria-label={t('projects.card.online', { names })}
            title={t('projects.card.online', { names })}
          >
            <AvatarStack
              max={ONLINE_SHOWN}
              users={online.map((u) => ({
                id: u.id,
                displayName: u.displayName,
                color: u.color,
                avatar: u.avatarUrl,
              }))}
            />
          </span>
        )}
        {items.length > 0 && (
          <div className="project-card-menu">
            <Menu
              label={t('projects.menu.label', { title: project.title })}
              items={items}
              trigger={(props) => (
                <Button
                  {...props}
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={t('projects.menu.label', { title: project.title })}
                >
                  <Icon name="more" />
                </Button>
              )}
            />
          </div>
        )}
      </div>
    </div>
  )
}
