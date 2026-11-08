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
  finish: 'check',
  reopen: 'check',
  delete: 'trash',
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
  /** Position in the list; drives the entrance stagger (capped to 8 steps). */
  index: number
  actions: ProjectAction[]
  onAction: (action: ProjectAction, project: ProjectCardData) => void
}

export function ProjectCard({ project, index, actions, onAction }: ProjectCardProps) {
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

  const background = image
    ? `linear-gradient(180deg, rgb(0 0 0 / 0) 25%, rgb(0 0 0 / 0.78)), left top / cover url(${image})`
    : gradientFor(project.id)

  return (
    <div
      ref={ref}
      className={cx('project-card', finished && 'is-finished')}
      data-flip-id={project.id}
      style={{ '--i': Math.min(index, 7) } as CSSProperties}
    >
      <AppLink to={`/projects/${project.id}`} className="project-card-link" style={{ background }}>
        <span className="project-card-title">{project.title}</span>
        <span className="project-card-meta">
          {project.contributors.length > 0 && (
            <AvatarStack
              users={project.contributors.map((c) => ({
                id: c.id,
                displayName: c.displayName,
                color: c.color,
                avatar: c.avatarUrl,
              }))}
            />
          )}
          <span className="project-card-count">
            {finished && `${t('projects.card.finished')} · `}
            {t('projects.card.participants', { count: project.participantCount })}
          </span>
        </span>
        <span className="project-card-open" aria-hidden="true">
          <Icon name="arrowRight" size={16} />
        </span>
      </AppLink>
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
  )
}
