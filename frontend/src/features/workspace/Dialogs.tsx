import { type DragEvent, useEffect, useRef, useState } from 'react'
import { isApiError } from '../../api/errors'
import { Button } from '../../components/Button'
import { Input } from '../../components/Input'
import { Modal } from '../../components/Modal'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import { type ImportMode, type ImportResult, importParticipants } from './api'
import { WsIcon } from './icons'
import { clampCount, MAX_ADD_ROWS } from './tableLogic'

// ---------------------------------------------------------------- add rows

export function AddRowsDialog({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (count: number) => void
}) {
  const { t, formatNumber } = useI18n()
  const [raw, setRaw] = useState('1')
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (open) {
      setRaw('1')
      setTouched(false)
    }
  }, [open])
  const count = clampCount(raw)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('workspace.add.title')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={count === null}
            onClick={() => count !== null && onSubmit(count)}
          >
            {t('workspace.add.submit')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setTouched(true)
          if (count !== null && !busy) onSubmit(count)
        }}
      >
        <Input
          data-autofocus
          name="rows"
          label={t('workspace.add.count')}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={raw}
          hint={t('workspace.add.hint', { max: formatNumber(MAX_ADD_ROWS) })}
          error={
            touched && count === null
              ? t('workspace.add.invalid', { max: formatNumber(MAX_ADD_ROWS) })
              : undefined
          }
          onChange={(e) => setRaw(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------- copy fallback

export function CopyFallbackDialog({ blob, onClose }: { blob: Blob | null; onClose: () => void }) {
  const { t } = useI18n()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) return
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return (
    <Modal
      open={blob !== null}
      onClose={onClose}
      title={t('workspace.copyFallback.title')}
      actions={
        <Button variant="primary" onClick={onClose}>
          {t('action.close')}
        </Button>
      }
    >
      <p className="muted">{t('workspace.copyFallback.body')}</p>
      {url && <img className="copy-fallback-img" src={url} alt={t('workspace.copyFallback.alt')} />}
    </Modal>
  )
}

// ---------------------------------------------------------------- import

const MAX_ERROR_ROWS = 100

export function ImportDialog({
  open,
  projectId,
  onClose,
  onDone,
}: {
  open: boolean
  projectId: string
  onClose: () => void
  onDone: (result: ImportResult) => void
}) {
  const { t, formatNumber } = useI18n()
  const [file, setFile] = useState<File | null>(null)
  const [mode, setMode] = useState<ImportMode>('append')
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [importing, setImporting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (open) return
    setFile(null)
    setPreview(null)
    setError(null)
    setMode('append')
  }, [open])

  // Every file or mode change re-runs the dry run; late answers of older runs are ignored.
  useEffect(() => {
    if (!file) return
    const run = ++seq.current
    setChecking(true)
    setError(null)
    importParticipants(projectId, file, mode, true)
      .then((r) => run === seq.current && setPreview(r))
      .catch((e) => {
        if (run !== seq.current) return
        setPreview(null)
        setError(errorText(e))
      })
      .finally(() => run === seq.current && setChecking(false))
  }, [file, mode, projectId])

  const pick = (f: File | undefined) => {
    if (!f) return
    setPreview(null)
    setFile(f)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    pick(e.dataTransfer.files[0])
  }

  const confirm = async () => {
    if (!file) return
    setImporting(true)
    try {
      onDone(await importParticipants(projectId, file, mode, false))
    } catch (e) {
      setError(isApiError(e) ? errorText(e) : t('errors.UNKNOWN'))
    } finally {
      setImporting(false)
    }
  }

  const shownErrors = preview?.errors.slice(0, MAX_ERROR_ROWS) ?? []
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('workspace.import.title')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={importing}
            disabled={!preview || checking || preview.valid === 0}
            onClick={() => void confirm()}
          >
            {t('workspace.import.confirm', { count: preview?.valid ?? 0 })}
          </Button>
        </>
      }
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag and drop is a pointer shortcut; the button inside is the accessible path */}
      <div
        className="drop"
        data-over={dragging || undefined}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <WsIcon name="upload" size={28} />
        <p>{file ? file.name : t('workspace.import.drop')}</p>
        <Button size="sm" onClick={() => input.current?.click()}>
          {file ? t('workspace.import.change') : t('workspace.import.choose')}
        </Button>
        <input
          ref={input}
          type="file"
          hidden
          accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          data-testid="import-file"
          onChange={(e) => {
            pick(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
      <p className="muted import-hint">{t('workspace.import.hint')}</p>

      <fieldset className="import-mode">
        <legend className="field-label">{t('workspace.import.mode')}</legend>
        {(['append', 'replace'] as const).map((m) => (
          <label key={m} className="import-radio">
            <input type="radio" name="import-mode" checked={mode === m} onChange={() => setMode(m)} />
            <span>
              {t(`workspace.import.mode.${m}`)}
              <small className="muted">{t(`workspace.import.mode.${m}.hint`)}</small>
            </span>
          </label>
        ))}
      </fieldset>

      {checking && (
        <p className="muted" role="status">
          {t('workspace.import.checking')}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {preview && !checking && (
        <div className="import-preview" role="status">
          <p>
            {t('workspace.import.summary', {
              total: formatNumber(preview.total),
              valid: formatNumber(preview.valid),
              errors: formatNumber(preview.errors.length),
            })}
          </p>
          {mode === 'replace' && <p className="import-warn">{t('workspace.import.replaceWarn')}</p>}
          {shownErrors.length > 0 && (
            <div className="import-errors">
              <table>
                <thead>
                  <tr>
                    <th>{t('workspace.import.col.row')}</th>
                    <th>{t('workspace.import.col.field')}</th>
                    <th>{t('workspace.import.col.problem')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownErrors.map((e) => (
                    <tr key={`${e.row}-${e.field}-${e.code}`}>
                      <td>{e.row}</td>
                      <td>{t(e.field === 'name' ? 'workspace.col.name' : 'workspace.col.phone')}</td>
                      <td>{e.message || e.code}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.errors.length > shownErrors.length && (
                <p className="muted">
                  {t('workspace.import.more', { count: preview.errors.length - shownErrors.length })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
