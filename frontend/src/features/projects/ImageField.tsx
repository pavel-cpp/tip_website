import { type DragEvent, useRef, useState } from 'react'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { INTL_TAG, useI18n } from '../../i18n'
import { cx } from '../../lib/cx'
import type { Project } from './api'
import { formatBytes, isOffRatio } from './draft'
import { useAuthedImage } from './useAuthedImage'
import './settings.css'

const ACCEPTED = ['image/png', 'image/jpeg']

interface Props {
  image: Project['image']
  /** 0..1 while an upload is running, otherwise null. */
  progress: number | null
  disabled?: boolean
  onFile: (file: File) => void
  onReject: (message: string) => void
}

/** Thumbnail + replace button + drop target. The ratio hint is gentle: it never blocks an upload. */
export function ImageField({ image, progress, disabled, onFile, onReject }: Props) {
  const { t, locale } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const thumb = useAuthedImage(image?.url)
  const busy = progress !== null

  const take = (file: File | undefined) => {
    if (!file || disabled || busy) return
    if (!ACCEPTED.includes(file.type)) {
      onReject(t('settings.image.badType'))
      return
    }
    onFile(file)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    take(e.dataTransfer.files[0])
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the keyboard path
    <div
      className={cx('image-field', over && 'is-over')}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <span className="image-thumb" style={thumb ? { backgroundImage: `url(${thumb})` } : undefined} />
      <div className="image-info">
        <Button size="sm" disabled={disabled || busy} onClick={() => input.current?.click()}>
          <Icon name="plus" size={16} />
          {t(image ? 'settings.image.replace' : 'settings.image.upload')}
        </Button>
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
        {busy ? (
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <span className="progress-bar" style={{ transform: `scaleX(${progress})` }} />
            <span className="muted progress-text">
              {t('settings.image.uploading', { percent: Math.round(progress * 100) })}
            </span>
          </div>
        ) : (
          image && (
            <span className="muted image-meta">
              {t('settings.image.meta', {
                name: image.name,
                size: formatBytes(image.bytes, INTL_TAG[locale]),
              })}
            </span>
          )
        )}
        {image && isOffRatio(image.w, image.h) && (
          <p className="image-hint" role="note">
            <Icon name="info" size={16} />
            {t('settings.image.ratioHint')}
          </p>
        )}
      </div>
      {over && <div className="image-drop">{t('settings.image.drop')}</div>}
    </div>
  )
}
