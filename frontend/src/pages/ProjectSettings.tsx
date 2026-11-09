import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { isApiError } from '../api/errors'
import { AppLink } from '../components/AppLink'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Input } from '../components/Input'
import { Modal } from '../components/Modal'
import { Panel } from '../components/Panel'
import { Skeleton, useSkeleton } from '../components/Skeleton'
import { Tabs } from '../components/Tabs'
import { useToast } from '../components/Toast'
import { useTopbarCrumbs } from '../components/TopbarSlot'
import { type Project, useProject, useReplaceImage, useUpdateProject } from '../features/projects/api'
import { buildPatch, type Draft, isDirty, normalizePlaceholder, toDraft } from '../features/projects/draft'
import { ImageField } from '../features/projects/ImageField'
import { PlaceholderControls } from '../features/projects/PlaceholderControls'
import { PlaceholderPreview } from '../features/projects/PlaceholderPreview'
import { useAuthedImage } from '../features/projects/useAuthedImage'
import { usePermissions } from '../features/projects/usePermissions'
import { useUnsavedGuard } from '../features/projects/useUnsavedGuard'
import { useI18n } from '../i18n'
import { errorText } from '../i18n/apiError'
import { PLACEHOLDER_KEYS, type PlaceholderKey, useImageElement } from '../lib/ticket'
import '../features/projects/settings.css'

export default function ProjectSettings() {
  const { id = '' } = useParams()
  const { t } = useI18n()
  const { can } = usePermissions()
  const project = useProject(id)
  // Path in the top bar (stream C); the page body below only keeps the heading.
  const settingsT = t('settings.title')
  useTopbarCrumbs(
    project.data
      ? [
          { label: t('projects.title'), to: '/' },
          { label: project.data.title, to: `/projects/${id}` },
          { label: settingsT },
        ]
      : [],
  )
  const showSkeleton = useSkeleton(project.isPending)

  if (!can('project.update')) {
    return (
      <div className="state-box" role="alert">
        <h2>{t('errors.FORBIDDEN')}</h2>
        <AppLink to="/">{t('projects.title')}</AppLink>
      </div>
    )
  }
  if (project.isError) {
    return (
      <div className="state-box" role="alert">
        <h2>{t('settings.error.title')}</h2>
        <p className="muted">{errorText(project.error)}</p>
        <Button onClick={() => void project.refetch()}>{t('action.retry')}</Button>
      </div>
    )
  }
  if (!project.data) {
    return showSkeleton ? (
      <div className="settings-grid" role="status" aria-label={t('state.loading')}>
        <Skeleton height={420} radius={18} />
        <Skeleton height={420} radius={18} />
      </div>
    ) : null
  }
  return <SettingsEditor project={project.data} refetch={async () => (await project.refetch()).data} />
}

function SettingsEditor({
  project,
  refetch,
}: {
  project: Project
  refetch: () => Promise<Project | undefined>
}) {
  const { t } = useI18n()
  const toast = useToast()
  const update = useUpdateProject(project.id)
  const replace = useReplaceImage(project.id)

  const [draft, setDraft] = useState<Draft>(() => toDraft(project))
  const [active, setActive] = useState<PlaceholderKey>('number')
  const [progress, setProgress] = useState<number | null>(null)
  const [conflict, setConflict] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(savedTimer.current), [])

  const readOnly = project.status === 'finished'
  const dirty = isDirty(draft, project)
  const guard = useUnsavedGuard(dirty)
  const location = useLocation()
  const navigateBack = useNavigate()

  const blobUrl = useAuthedImage(project.image?.url)
  const image = useImageElement(blobUrl)
  const size = useMemo(
    () => (project.image ? { w: project.image.w, h: project.image.h } : null),
    [project.image],
  )

  const values = {
    number: t('ticket.sample.number'),
    name: t('ticket.sample.name'),
    phone: t('ticket.sample.phone'),
  }

  const patchPlaceholder = (key: PlaceholderKey, patch: Partial<Draft['placeholders'][PlaceholderKey]>) =>
    setDraft((d) => ({
      ...d,
      placeholders: {
        ...d.placeholders,
        [key]: normalizePlaceholder({ ...d.placeholders[key], ...patch }, size),
      },
    }))

  const save = async (base: Project = project) => {
    try {
      const next = await update.mutateAsync(buildPatch(draft, base))
      setDraft(toDraft(next))
      setConflict(false)
      setSaved(true)
      clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), 1500)
      toast.show({ message: t('settings.saved') })
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true)
      else toast.show({ message: errorText(e), tone: 'error' })
    }
  }

  const upload = (file: File) => {
    setProgress(0)
    replace.mutate(
      { file, onProgress: setProgress },
      {
        onError: (e) => toast.show({ message: errorText(e), tone: 'error' }),
        onSettled: () => setProgress(null),
      },
    )
  }

  const titleEmpty = draft.title.trim() === ''
  const tabs = PLACEHOLDER_KEYS.map((k) => ({ id: k, label: t(`settings.ph.${k}`) }))

  return (
    <>
      <div className="settings-head">
        <h1 className="breadcrumb-current sr-only">{t('settings.title')}</h1>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('action.close')}
          onClick={() =>
            // Back to where the user came from; a direct visit falls back to the workspace (stream C).
            !dirty && location.key !== 'default'
              ? void navigateBack(-1)
              : guard.requestLeave(`/projects/${project.id}`)
          }
        >
          <Icon name="x" />
        </Button>
      </div>

      {readOnly && (
        <p className="image-hint" role="status">
          <Icon name="info" size={16} />
          {t('settings.readOnly')}
        </p>
      )}

      <div className="settings-grid">
        <Panel title={t('settings.preview.title')} icon="pencil" className="settings-preview">
          {image && size ? (
            <PlaceholderPreview
              image={image}
              size={size}
              placeholders={draft.placeholders}
              values={values}
              active={active}
              onSelect={setActive}
              onMove={(key, p) => patchPlaceholder(key, p)}
              disabled={readOnly}
            />
          ) : (
            <p className="muted preview-empty">
              {project.image ? t('state.loading') : t('settings.preview.empty')}
            </p>
          )}
        </Panel>

        <Panel title={t('settings.title')} icon="settings" className="settings-form">
          <form
            className="settings-fields"
            onSubmit={(e) => {
              e.preventDefault()
              if (dirty && !titleEmpty && !readOnly) void save()
            }}
          >
            <Input
              name="title"
              label={t('settings.name')}
              value={draft.title}
              maxLength={200}
              autoComplete="off"
              disabled={readOnly}
              error={titleEmpty ? t('validation.required') : undefined}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            />
            <div className="field">
              <span className="field-label">{t('settings.image')}</span>
              <ImageField
                image={project.image}
                progress={progress}
                disabled={readOnly}
                onFile={upload}
                onReject={(message) => toast.show({ message, tone: 'error' })}
              />
            </div>

            <h2 className="settings-subtitle">{t('settings.placeholders')}</h2>
            <Tabs
              tabs={tabs}
              value={active}
              onChange={(k) => setActive(k as PlaceholderKey)}
              label={t('settings.tabs.label')}
            />
            <PlaceholderControls
              value={draft.placeholders[active]}
              image={size ?? { w: 100_000, h: 100_000 }}
              disabled={readOnly}
              onChange={(patch) => patchPlaceholder(active, patch)}
            />

            <div className="settings-actions">
              <Button variant="ghost" onClick={() => guard.requestLeave('/')}>
                {t('action.cancel')}
              </Button>
              <Button
                variant="primary"
                type="submit"
                loading={update.isPending}
                disabled={!dirty || titleEmpty || readOnly}
              >
                {saved ? <Icon name="check" size={16} /> : null}
                {t('action.save')}
              </Button>
            </div>
          </form>
        </Panel>
      </div>

      <Modal
        open={conflict}
        onClose={() => setConflict(false)}
        title={t('settings.conflict.title')}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={async () => {
                const fresh = await refetch()
                if (fresh) setDraft(toDraft(fresh))
                setConflict(false)
              }}
            >
              {t('settings.conflict.reload')}
            </Button>
            <Button
              variant="primary"
              loading={update.isPending}
              onClick={async () => {
                const fresh = await refetch()
                if (fresh) await save(fresh)
              }}
            >
              {t('settings.conflict.overwrite')}
            </Button>
          </>
        }
      >
        <p className="muted">{t('settings.conflict.body')}</p>
      </Modal>

      <Modal
        open={guard.pending}
        onClose={guard.stay}
        title={t('settings.leave.title')}
        actions={
          <>
            <Button variant="ghost" onClick={guard.stay}>
              {t('settings.leave.stay')}
            </Button>
            <Button variant="danger" onClick={guard.leave}>
              {t('settings.leave.leave')}
            </Button>
          </>
        }
      >
        <p className="muted">{t('settings.leave.body')}</p>
      </Modal>
    </>
  )
}
