import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Input } from '../components/Input'
import { Skeleton, useSkeleton } from '../components/Skeleton'
import { useToast } from '../components/Toast'
import {
  type ProjectCardData,
  useCreateProject,
  useDeleteProject,
  useProjects,
  useSetProjectStatus,
} from '../features/projects/api'
import { type ProjectAction, projectActions, splitProjects } from '../features/projects/logic'
import { ProjectCard } from '../features/projects/ProjectCard'
import { CreateProjectDialog, DeleteProjectDialog } from '../features/projects/ProjectDialogs'
import { useFlip } from '../features/projects/useFlip'
import { usePermissions } from '../features/projects/usePermissions'
import { useI18n } from '../i18n'
import { errorText } from '../i18n/apiError'
import '../features/projects/projects.css'

export default function Projects() {
  const { t } = useI18n()
  const { can } = usePermissions()
  const navigate = useNavigate()
  const toast = useToast()
  const projects = useProjects()
  const create = useCreateProject()
  const setStatus = useSetProjectStatus()
  const remove = useDeleteProject()

  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ProjectCardData | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  useFlip(grid)

  const showSkeleton = useSkeleton(projects.isPending)
  const canCreate = can('project.create')
  const sections = splitProjects(projects.data ?? [], query, can('project.view_finished'))

  const onAction = (action: ProjectAction, project: ProjectCardData) => {
    if (action === 'settings') {
      void navigate(`/projects/${project.id}/settings`, { viewTransition: true })
    } else if (action === 'delete') {
      setDeleting(project)
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
  const searching = query.trim() !== ''

  const renderSection = (key: 'active' | 'finished', list: ProjectCardData[], extra?: React.ReactNode) => {
    if (list.length === 0 && !extra) return null
    return (
      <section className="project-section" aria-labelledby={`sec-${key}`}>
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
              actions={projectActions(can, p.status)}
              onAction={onAction}
            />
          ))}
          {extra}
        </div>
      </section>
    )
  }

  const createCard = canCreate && !searching && (
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
        <h1 className="page-title">{t('projects.title')}</h1>
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

      <CreateProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreate={async (title) => {
          const project = await create.mutateAsync(title)
          setCreating(false)
          void navigate(`/projects/${project.id}/settings`, { viewTransition: true })
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
