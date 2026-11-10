import { useEffect, useId, useRef, useState } from 'react'
import { isApiError } from '../../api/errors'
import { Button } from '../../components/Button'
import { Input } from '../../components/Input'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toast'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import { type CustomFont, FONT_LIMITS, fontFileProblem, fontNameFromFile, useUploadFont } from './fontsApi'
import './fonts.css'

interface Props {
  open: boolean
  onClose: () => void
  onUploaded: (font: CustomFont) => void
}

/** Opens the file as a font in the browser; a file that cannot be parsed would only fail later on the canvas. */
async function readableAsFont(file: File): Promise<boolean> {
  if (typeof FontFace === 'undefined') return true
  try {
    await new FontFace('probe', await file.arrayBuffer()).load()
    return true
  } catch {
    return false
  }
}

export function FontUploadDialog({ open, onClose, onUploaded }: Props) {
  const { t, formatBytes } = useI18n()
  const toast = useToast()
  const upload = useUploadFont()
  const fileId = useId()
  const licenseId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [licence, setLicence] = useState(false)
  const [fileError, setFileError] = useState('')
  const [nameError, setNameError] = useState('')
  const [licenceError, setLicenceError] = useState('')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (open) return
    setFile(null)
    setName('')
    setLicence(false)
    setFileError('')
    setNameError('')
    setLicenceError('')
  }, [open])

  const choose = async (picked: File | undefined) => {
    if (!picked) return
    setFile(null)
    setFileError('')
    const problem = fontFileProblem(picked)
    if (problem === 'type') return setFileError(t('fonts.upload.badType'))
    if (problem === 'size')
      return setFileError(t('fonts.upload.tooLarge', { size: formatBytes(FONT_LIMITS.maxBytes) }))
    setChecking(true)
    const ok = await readableAsFont(picked)
    setChecking(false)
    if (!ok) return setFileError(t('fonts.upload.unreadable'))
    setFile(picked)
    setName((n) => n || fontNameFromFile(picked.name))
    setNameError('')
  }

  const submit = async () => {
    const trimmed = name.trim()
    const problems = [!file, !trimmed, !licence]
    setFileError(file ? '' : fileError || t('fonts.upload.noFile'))
    setNameError(trimmed ? '' : t('fonts.upload.nameRequired'))
    setLicenceError(licence ? '' : t('fonts.upload.licenseRequired'))
    if (problems.some(Boolean) || !file) return
    try {
      const font = await upload.mutateAsync({ file, name: trimmed, licenseConfirmed: true })
      toast.show({ message: t('fonts.uploaded', { name: font.name }) })
      onUploaded(font)
      onClose()
    } catch (e) {
      if (isApiError(e) && e.code === 'TOO_LARGE')
        setFileError(t('fonts.upload.tooLarge', { size: formatBytes(FONT_LIMITS.maxBytes) }))
      else if (isApiError(e) && e.code === 'UNSUPPORTED_MEDIA') setFileError(t('fonts.upload.unreadable'))
      else toast.show({ message: errorText(e), tone: 'error' })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('fonts.upload.title')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" loading={upload.isPending || checking} onClick={() => void submit()}>
            {t('fonts.upload.submit')}
          </Button>
        </>
      }
    >
      <form
        className="fu"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor={`${fileId}-btn`}>
            {t('fonts.upload.file')}
          </label>
          <div className="fu-file">
            <Button
              id={`${fileId}-btn`}
              size="sm"
              data-autofocus
              aria-describedby={fileError ? `${fileId}-error` : undefined}
              onClick={() => input.current?.click()}
            >
              {t('fonts.upload.choose')}
            </Button>
            <span className="muted fu-file-name">
              {file ? file.name : t('fonts.upload.formats', { size: formatBytes(FONT_LIMITS.maxBytes) })}
            </span>
            <input
              ref={input}
              type="file"
              accept=".ttf,.otf,.woff2,font/ttf,font/otf,font/woff2"
              hidden
              aria-label={t('fonts.upload.file')}
              onChange={(e) => {
                void choose(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </div>
          {fileError && (
            <span id={`${fileId}-error`} className="field-error" role="alert">
              {fileError}
            </span>
          )}
        </div>
        <Input
          label={t('fonts.upload.name')}
          value={name}
          maxLength={FONT_LIMITS.maxNameLength}
          autoComplete="off"
          error={nameError || undefined}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="fu-license">
          <input
            id={licenseId}
            type="checkbox"
            checked={licence}
            aria-invalid={licenceError ? true : undefined}
            onChange={(e) => setLicence(e.target.checked)}
          />
          <label htmlFor={licenseId}>{t('fonts.upload.license')}</label>
        </div>
        {licenceError && (
          <span className="field-error" role="alert">
            {licenceError}
          </span>
        )}
      </form>
    </Modal>
  )
}
