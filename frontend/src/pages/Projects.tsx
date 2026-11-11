import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Input } from '../components/Input'
import { Skeleton, useSkeleton } from '../components/Skeleton'
import { useToast } from '../components/Toast'
import {
  type ProjectCardData,
  type ProjectStatus,
  useCreateProject,
  useDeleteProject,
  useMoveProject,
  useProjects,
  useSetProjectStatus,
} from '../features/projects/api'
import {
  type ProjectAction,
  type ProjectSections,
  projectActions,
  splitProjects,
} from '../features/projects/logic'
import { moveProject, orderedIds } from '../features/projects/order'
import { ProjectCard } from '../features/projects/ProjectCard'
import { CreateProjectDialog, DeleteProjectDialog } from '../features/projects/ProjectDialogs'
import { useFlip } from '../features/projects/useFlip'
import { usePermissions } from '../features/projects/usePermissions'
import { useProjectDnd } from '../features/projects/useProjectDnd'
import { useI18n } from '../i18n'
import { errorText } from '../i18n/apiError'
import { cx } from '../lib/cx'
import '../features/projects/projects.css'

export default function Projects() {
  const { t } = useI18n()
  const { can } = usePermissions()
  const navigate = useNavigate()
  const toast = useToast()
  const [pending, setPending] = useState<ProjectSections | null>(null)
  const [dragging, setDragging] = useState(false)
  const projects = useProjects(dragging || pending !== null)
  const create = useCreateProject()
  const setStatus = useSetProjectStatus()
  const remove = useDeleteProject()
  const move = useMoveProject()

  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ProjectCardData | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const flip = useFlip(grid, dragging)

  const showSkeleton = useSkeleton(projects.isPending)
  const canCreate = can('project.create')
  const searching = query.trim() !== ''
  const canReorder = can('project.update')
  const canMove = can('project.finish') && can('project.view_finished')
  const base = splitProjects(projects.data ?? [], query, can('project.view_finished'))
  // While a move is being saved the page shows its own arrangement; it falls back to the server list
  // when the request settles, which is also the rollback on error.
  const sections = pending && !searching ? pending : base

  const commitMove = (next: ProjectSections, project: ProjectCardData, to: ProjectStatus) => {
    const crossing = project.status !== to
    const ids = canReorder ? orderedIds(next) : null
    if (!crossing && !ids) return
    setPending(next)
    move.mutate(
      { ids, status: crossing ? { id: project.id, status: to } : undefined },
      {
        onSuccess: () => {
          if (crossing) {
            toast.show({
              message: t(to === 'finished' ? 'projects.toast.finished' : 'projects.toast.reopened', {
                title: project.title,
              }),
            })
          }
        },
        onError: (e) => toast.show({ message: errorText(e), tone: 'error' }),
        onSettled: () => setPending(null),
      },
    )
  }

  const dragEnabled = !searching && (canReorder || canMove) && projects.isSuccess
  const dnd = useProjectDnd({
    enabled: dragEnabled,
    canReorder,
    canMove,
    root: grid,
    onDrop: (id, _from, to, index, rect) => {
      const project = [...sections.active, ...sections.finished].find((p) => p.id === id)
      const next = project && moveProject(sections, id, to, index)
      if (!project || !next) return false
      flip.release(id, rect)
      commitMove(next, project, to)
      return true
    },
  })
  const isDragging = dnd.dragId !== null
  if (isDragging !== dragging) setDragging(isDragging)
  const dragFrom = [...sections.active, ...sections.finished].find((p) => p.id === dnd.dragId)?.status

  const onAction = (action: ProjectAction, project: ProjectCardData) => {
    if (action === 'settings') {
      void navigate(`/projects/${project.id}/settings`)
    } else if (action === 'delete') {
      setDeleting(project)
    } else if (action === 'moveUp' || action === 'moveDown') {
      const list = project.status === 'active' ? sections.active : sections.finished
      const at = list.findIndex((p) => p.id === project.id)
      const to = action === 'moveUp' ? at - 1 : at + 1
      const next = moveProject(sections, project.id, project.status, to)
      if (!next) return
      commitMove(next, project, project.status)
      // Announced to screen readers through the toast live region: the menu has no other feedback.
      toast.show({
        message: t('projects.toast.moved', { title: project.title, position: to + 1, count: list.length }),
      })
    } else {
      const status = action === 'finish' ? 'finished' : 'active'
      setStatus.mutate(
        { id: project.id, status },
        {
          onSuccess: () =>
            toast.show({
              message: t(action === 'finish' ? 'projects.toast.finished' : 'projects.toast.reopened', {
                title: project.title,
              }),
            }),
          onError: (e) => toast.show({ message: errorText(e), tone: 'error' }),
        },
      )
    }
  }

  const total = sections.active.length + sections.finished.length

  const renderSection = (key: 'active' | 'finished', list: ProjectCardData[], extra?: React.ReactNode) => {
    const dropReady = isDragging && (key === dragFrom || canMove)
    if (list.length === 0 && !extra && !dropReady) return null
    return (
      <section
        className={cx(
          'project-section',
          dropReady && 'is-drop-ready',
          dnd.target?.status === key && 'is-drop-target',
        )}
        data-drop-section={key}
        aria-labelledby={`sec-${key}`}
      >
        <h2
          id={`sec-${key}`}
          className={key === 'finished' ? 'project-section-title muted' : 'project-section-title'}
        >
          {t(key === 'active' ? 'projects.active' : 'projects.finished')}
        </h2>
        <div className="project-grid">
          {list.map((p, i) => (
            <ProjectCard
              key={p.id}
              project={p}
              index={i}
              actions={projectActions(
                can,
                p.status,
                searching ? undefined : { index: i, count: list.length },
              )}
              onAction={onAction}
              dragProps={dragEnabled ? dnd.cardProps(p.id, p.status) : undefined}
              dragging={dnd.dragId === p.id}
            />
          ))}
          {extra}
          {list.length === 0 && dropReady && (
            <div className="project-drop-empty">
              {t(key === 'active' ? 'projects.drop.active' : 'projects.drop.finished')}
            </div>
          )}
        </div>
      </section>
    )
  }

  // The card is part of the grid, so it would read as a drop slot; it steps aside while a project is dragged.
  const createCard = canCreate && !searching && !isDragging && (
    <button
      type="button"
      className="project-card project-create"
      data-flip-id="create"
      onClick={() => setCreating(true)}
    >
      <Icon name="plus" size={22} className="project-create-plus" />
      <span>{t('projects.create.card')}</span>
    </button>
  )

  let body: React.ReactNode
  if (projects.isError) {
    body = (
      <div className="state-box" role="alert">
        <h2>{t('projects.error.title')}</h2>
        <p className="muted">{errorText(projects.error)}</p>
        <Button onClick={() => void projects.refetch()}>{t('action.retry')}</Button>
      </div>
    )
  } else if (projects.isPending) {
    body = showSkeleton ? (
      <div className="project-grid" role="status" aria-label={t('state.loading')}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={216} radius={18} />
        ))}
      </div>
    ) : null
  } else if (total === 0 && searching) {
    body = (
      <div className="state-box">
        <h2>{t('projects.empty.search.title')}</h2>
        <p className="muted">{t('projects.empty.search.hint')}</p>
      </div>
    )
  } else if (total === 0 && !canCreate) {
    body = (
      <div className="state-box">
        <h2>{t('projects.empty.worker.title')}</h2>
        <p className="muted">{t('projects.empty.worker.hint')}</p>
      </div>
    )
  } else if (total === 0) {
    body = (
      <div className="state-box">
        <h2>{t('projects.empty.admin.title')}</h2>
        <p className="muted">{t('projects.empty.admin.hint')}</p>
        <Button variant="primary" onClick={() => setCreating(true)}>
          {t('projects.empty.admin.cta')}
        </Button>
      </div>
    )
  } else {
    body = (
      <>
        {renderSection('active', sections.active, createCard)}
        {renderSection('finished', sections.finished)}
      </>
    )
  }

  return (
    <>
      <div className="projects-head">
        <h1 className="page-title" data-morph="heading" data-morph-text="">
          {t('projects.title')}
        </h1>
        <Input
          className="projects-search"
          type="search"
          name="q"
          icon="search"
          label={t('projects.search')}
          placeholder={t('projects.search')}
          value={query}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div ref={grid}>{body}</div>
      {dnd.target?.line && (
        <div
          className="drop-line"
          aria-hidden="true"
          style={{
            transform: `translate3d(${dnd.target.line.x}px, ${dnd.target.line.y}px, 0)`,
            height: dnd.target.line.h,
          }}
        />
      )}

      <CreateProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreate={async (title) => {
          const project = await create.mutateAsync(title)
          setCreating(false)
          void navigate(`/projects/${project.id}/settings`)
        }}
      />
      <DeleteProjectDialog
        title={deleting?.title ?? null}
        onClose={() => setDeleting(null)}
        onDelete={async () => {
          if (!deleting) return
          const { id, title } = deleting
          await remove.mutateAsync(id)
          setDeleting(null)
          toast.show({ message: t('projects.toast.deleted', { title }) })
        }}
      />
    </>
  )
}
