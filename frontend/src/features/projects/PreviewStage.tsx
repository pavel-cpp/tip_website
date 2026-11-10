import { type DragEvent, useRef, useState } from 'react'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { useI18n } from '../../i18n'
import { cx } from '../../lib/cx'
import type { PlaceholderKey, TicketPlaceholders, TicketValues } from '../../lib/ticket'
import type { Project } from './api'
import { dragHasFiles, imageFileProblem } from './imageFile'
import { PlaceholderPreview } from './PlaceholderPreview'
import './settings.css'

interface Props {
  project: Pick<Project, 'image'>
  image: HTMLImageElement | null
  placeholders: TicketPlaceholders
  values: TicketValues
  active: PlaceholderKey
  onSelect: (key: PlaceholderKey) => void
  onMove: (key: PlaceholderKey, p: { x: number; y: number }) => void
  /** 0..1 while an upload runs, otherwise null. */
  progress: number | null
  /** Text of the last failed attempt; cleared by the parent on the next one. */
  error: string | null
  disabled?: boolean
  onFile: (file: File) => void
  onReject: (reason: 'type' | 'size') => void
}

/**
 * The main area of the settings page: the ticket preview that is also the drop target for the picture.
 * Without a picture it is a large drop zone; with one, dropping a file replaces it and the bar below the
 * preview offers the same through a file picker.
 */
export function PreviewStage({
  project,
  image,
  placeholders,
  values,
  active,
  onSelect,
  onMove,
  progress,
  error,
  disabled,
  onFile,
  onReject,
}: Props) {
  const { t, formatBytes } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  const depth = useRef(0)
  const [over, setOver] = useState(false)
  const meta = project.image
  const busy = progress !== null
  const locked = disabled || busy

  const take = (file: File | undefined) => {
    if (!file || locked) return
    const problem = imageFileProblem(file)
    if (problem) onReject(problem)
    else onFile(file)
  }

  const onDragEnter = (e: DragEvent) => {
    if (locked || !dragHasFiles(e.dataTransfer)) return
    e.preventDefault()
    depth.current += 1
    setOver(true)
  }
  const onDragOver = (e: DragEvent) => {
    if (locked || !dragHasFiles(e.dataTransfer)) return
    // Without this the browser would open the file instead of dropping it here.
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setOver(false)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    depth.current = 0
    setOver(false)
    take(e.dataTransfer.files[0])
  }

  const picker = (
    <input
      ref={input}
      type="file"
      accept="image/png,image/jpeg"
      hidden
      onChange={(e) => {
        take(e.target.files?.[0])
        e.target.value = ''
      }}
    />
  )

  return (
    <div className="st-stage">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the choose-file button below is the keyboard path */}
      <div
        className={cx('st-drop', over && 'is-over')}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {image && meta ? (
          <PlaceholderPreview
            image={image}
            size={{ w: meta.w, h: meta.h }}
            placeholders={placeholders}
            values={values}
            active={active}
            onSelect={onSelect}
            onMove={onMove}
            disabled={disabled}
          />
        ) : (
          <div className="st-empty">
            <Icon name="folder" size={28} />
            <p className="st-empty-title">{meta ? t('state.loading') : t('settings.preview.empty')}</p>
            {!meta && (
              <>
                <p className="muted">{t('settings.drop.hint')}</p>
                <Button
                  variant="primary"
                  disabled={locked}
                  disabledReason={disabled ? t('settings.readOnly') : undefined}
                  onClick={() => input.current?.click()}
                >
                  <Icon name="plus" size={16} />
                  {t('settings.image.choose')}
                </Button>
              </>
            )}
          </div>
        )}
        {over && (
          <div className="st-drop-veil" aria-hidden="true">
            <Icon name="plus" size={28} />
            <span>{t('settings.drop.release')}</span>
          </div>
        )}
        {busy && (
          <div
            className="st-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label={t('settings.image.uploading', { percent: Math.round(progress * 100) })}
          >
            <span className="progress-bar" style={{ transform: `scaleX(${progress})` }} />
            <span className="st-progress-text">
              {t('settings.image.uploading', { percent: Math.round(progress * 100) })}
            </span>
          </div>
        )}
      </div>

      <div className="st-picture">
        <div className="st-picture-info">
          {meta ? (
            <span className="st-picture-name">
              {t('settings.image.meta', { name: meta.name, size: formatBytes(meta.bytes) })}
              <span className="muted">
                {' '}
                · {meta.w}×{meta.h}
              </span>
            </span>
          ) : (
            <span className="muted">{t('settings.image.formats', { size: formatBytes(10 << 20) })}</span>
          )}
          {error && (
            <p className="st-error" role="alert">
              <Icon name="alert" size={16} />
              {error}
            </p>
          )}
        </div>
        {meta && (
          <Button
            size="sm"
            disabled={locked}
            disabledReason={disabled ? t('settings.readOnly') : busy ? t('settings.image.busy') : undefined}
            onClick={() => input.current?.click()}
          >
            <Icon name="plus" size={16} />
            {t('settings.image.replace')}
          </Button>
        )}
        {picker}
      </div>
    </div>
  )
}
