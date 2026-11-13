import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { isApiError } from '../api/errors'
import { AppLink } from '../components/AppLink'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { Panel } from '../components/Panel'
import { Skeleton, useSkeleton } from '../components/Skeleton'
import { Tabs } from '../components/Tabs'
import { useToast } from '../components/Toast'
import { useTopbarCrumbs } from '../components/TopbarSlot'
import { type Project, useProject, useReplaceImage, useUpdateProject } from '../features/projects/api'
import { buildPatch, type Draft, isDirty, normalizePlaceholder, toDraft } from '../features/projects/draft'
import { MAX_IMAGE_BYTES } from '../features/projects/imageFile'
import { PlaceholderControls } from '../features/projects/PlaceholderControls'
import { PreviewStage } from '../features/projects/PreviewStage'
import { useAuthedImage } from '../features/projects/useAuthedImage'
import { usePermissions } from '../features/projects/usePermissions'
import { useUnsavedGuard } from '../features/projects/useUnsavedGuard'
import { useParticipants } from '../features/workspace/api'
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
  const { t, formatBytes } = useI18n()
  const toast = useToast()
  const update = useUpdateProject(project.id)
  const replace = useReplaceImage(project.id)

  const [draft, setDraft] = useState<Draft>(() => toDraft(project))
  const [active, setActive] = useState<PlaceholderKey>('number')
  const [progress, setProgress] = useState<number | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
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

  // Coming from the workspace the preview shows the participant that was on screen there; coming from
  // anywhere else it shows neutral sample text. The list is already cached after a visit to the workspace.
  const fromRowId = (location.state as { rowId?: string | null } | null)?.rowId ?? null
  const perms = usePermissions()
  const rows = useParticipants(project.id, !!fromRowId && perms.can('participant.view'))
  const fromRow = fromRowId ? rows.data?.items.find((r) => r.id === fromRowId) : undefined
  const values = fromRow
    ? { number: String(fromRow.number), name: fromRow.name, phone: fromRow.phone }
    : {
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
    setImageError(null)
    setProgress(0)
    replace.mutate(
      { file, onProgress: setProgress },
      {
        onSuccess: (next) => {
          // The server rescales the placeholders when the picture size changes; the draft follows it.
          const before = project.image
          if (!next.image || (before && before.w === next.image.w && before.h === next.image.h)) return
          setDraft((d) => ({ ...d, placeholders: toDraft(next).placeholders }))
          if (before) toast.show({ message: t('settings.image.adapted') })
        },
        onError: (e) => setImageError(errorText(e)),
        onSettled: () => setProgress(null),
      },
    )
  }

  const titleEmpty = draft.title.trim() === ''
  const tabs = PLACEHOLDER_KEYS.map((k) => ({ id: k, label: t(`settings.ph.${k}`) }))
  const canSave = dirty && !titleEmpty && !readOnly

  // Ctrl/Cmd+S saves, as in any editor; the browser's own "save page" would be useless here.
  const saveRef = useRef(() => {})
  saveRef.current = () => {
    if (canSave && !update.isPending) void save()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <form
        className="st"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          saveRef.current()
        }}
      >
        <h1 className="sr-only">{t('settings.title')}</h1>
        <div className="settings-head">
          <div className="st-title-wrap">
            <label className="field-label" htmlFor="st-title">
              {t('settings.name')}
            </label>
            <div className="st-title-box" data-invalid={titleEmpty || undefined}>
              <input
                id="st-title"
                className="st-title"
                data-morph={`title:${project.id}`}
                data-morph-text=""
                name="title"
                title={t('settings.titleHint')}
                value={draft.title}
                maxLength={200}
                autoComplete="off"
                disabled={readOnly}
                aria-invalid={titleEmpty || undefined}
                aria-describedby={titleEmpty ? 'st-title-error' : undefined}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              />
              {!readOnly && <Icon name="pencil" size={18} />}
            </div>
            {titleEmpty && (
              <span id="st-title-error" className="field-error st-title-error" role="alert">
                {t('validation.required')}
              </span>
            )}
          </div>
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
          <PreviewStage
            project={project}
            image={image}
            placeholders={draft.placeholders}
            values={values}
            active={active}
            onSelect={setActive}
            onMove={(key, p) => patchPlaceholder(key, p)}
            progress={progress}
            error={imageError}
            disabled={readOnly}
            onFile={upload}
            onReject={(reason) =>
              setImageError(
                reason === 'type'
                  ? t('settings.image.badType')
                  : t('settings.image.tooLarge', { size: formatBytes(MAX_IMAGE_BYTES) }),
              )
            }
          />

          <Panel title={t('settings.placeholders')} icon="settings" className="st-side" reveal="side">
            <div className="settings-fields">
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
            </div>
          </Panel>
        </div>

        <div className="st-bar">
          <p className="st-status" role="status" data-dirty={dirty || undefined}>
            <span className="st-dot" aria-hidden="true" />
            {dirty ? t('settings.status.unsaved') : t('settings.status.saved')}
          </p>
          <div className="st-bar-actions">
            <Button variant="ghost" disabled={!dirty || readOnly} onClick={() => setDraft(toDraft(project))}>
              {t('settings.discard')}
            </Button>
            <Button variant="primary" type="submit" loading={update.isPending} disabled={!canSave}>
              {saved ? <Icon name="check" size={16} /> : null}
              {t('action.save')}
            </Button>
          </div>
        </div>
      </form>

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
