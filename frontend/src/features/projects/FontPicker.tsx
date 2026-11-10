import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { isApiError } from '../../api/errors'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toast'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import { cx } from '../../lib/cx'
import { customFontId, customFontRef, ensureCatalogFonts, ensureCustomFont } from '../../lib/ticket'
import { FontUploadDialog } from './FontUploadDialog'
import {
  FONT_FILTERS,
  type FontFilter,
  filterFonts,
  type PickerFont,
  pickerFonts,
  previewFamily,
} from './fontCatalog'
import { useDeleteFont, useFonts } from './fontsApi'
import './fonts.css'

interface Props {
  value: string
  onChange: (font: string) => void
  disabled?: boolean
  label: string
}

/** True once the element has been near the viewport; without IntersectionObserver (tests) it is always true. */
function useSeen(ref: { current: Element | null }): boolean {
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (seen || !el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          io.disconnect()
        }
      },
      { rootMargin: '120px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, seen])
  return seen
}

function FontOption({
  font,
  id,
  selected,
  active,
  onPick,
}: {
  font: PickerFont
  id: string
  selected: boolean
  active: boolean
  onPick: () => void
}) {
  const row = useRef<HTMLDivElement>(null)
  // Each face is requested only when its row is about to be shown (docs/06-frontend.md: lazy fonts).
  const seen = useSeen(row)
  useEffect(() => {
    if (seen && font.custom) void ensureCustomFont(font.value)
  }, [seen, font.custom, font.value])

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the search combobox that owns this listbox
    <div
      ref={row}
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      className={cx('fp-option', active && 'is-active')}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      <span className="fp-name" style={seen ? { fontFamily: previewFamily(font.value) } : undefined}>
        {font.label}
      </span>
      {selected && <Icon name="check" size={16} />}
    </div>
  )
}

/**
 * Font picker: a searchable, categorised listbox where every entry is drawn in its own face. It follows
 * the combobox pattern (focus stays in the search field, the highlighted option is aria-activedescendant).
 */
export function FontPicker({ value, onChange, disabled, label }: Props) {
  const { t } = useI18n()
  const toast = useToast()
  const fonts = useFonts()
  const del = useDeleteFont()
  const base = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FontFilter>('all')
  const [highlight, setHighlight] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [removing, setRemoving] = useState<PickerFont | null>(null)
  const list = useRef<HTMLDivElement>(null)

  const all = useMemo(() => pickerFonts(fonts.data), [fonts.data])
  const shown = useMemo(() => filterFonts(all, query, filter), [all, query, filter])
  const current = all.find((f) => f.value === value)
  const missing = customFontId(value) !== null && !current

  // The trigger shows the current font in its own face, so its rules and file are needed up front.
  useEffect(() => {
    void ensureCatalogFonts()
    void ensureCustomFont(value)
  }, [value])

  useEffect(() => setHighlight(0), [query, filter])
  useEffect(() => {
    if (open) list.current?.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' })
  }, [open, highlight])

  const close = () => {
    setOpen(false)
    setQuery('')
  }
  const pick = (f: PickerFont) => {
    onChange(f.value)
    close()
  }
  const optionId = (i: number) => `${base}-o${i}`

  const onKey = (e: KeyboardEvent) => {
    const last = shown.length - 1
    if (e.key === 'ArrowDown') setHighlight((h) => Math.min(h + 1, last))
    else if (e.key === 'ArrowUp') setHighlight((h) => Math.max(h - 1, 0))
    else if (e.key === 'Home') setHighlight(0)
    else if (e.key === 'End') setHighlight(Math.max(last, 0))
    else if (e.key === 'Enter') {
      const f = shown[highlight]
      if (f) pick(f)
    } else return
    e.preventDefault()
  }

  const confirmRemove = async () => {
    const target = removing
    if (!target?.custom) return
    try {
      await del.mutateAsync(target.custom.id)
      toast.show({ message: t('fonts.deleted') })
    } catch (e) {
      toast.show({
        message: isApiError(e) && e.code === 'VALIDATION' ? t('fonts.inUse') : errorText(e),
        tone: 'error',
      })
    }
    setRemoving(null)
  }

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={`${base}-btn`}>
          {label}
        </label>
        <button
          id={`${base}-btn`}
          type="button"
          className="input fp-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <span className="fp-name" style={{ fontFamily: previewFamily(value) }}>
            {current?.label ?? (missing ? '…' : value)}
          </span>
          <Icon name="list" size={16} />
        </button>
      </div>

      <Modal
        open={open}
        onClose={close}
        title={label}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                close()
                setUploading(true)
              }}
            >
              <Icon name="plus" size={16} />
              {t('fonts.upload')}
            </Button>
            <Button onClick={close}>{t('action.close')}</Button>
          </>
        }
      >
        <div className="fp">
          <div className="input fp-search">
            <Icon name="search" size={16} />
            <input
              role="combobox"
              aria-expanded="true"
              aria-controls={`${base}-list`}
              aria-activedescendant={shown.length > 0 ? optionId(highlight) : undefined}
              aria-label={t('fonts.search')}
              placeholder={t('fonts.search')}
              autoComplete="off"
              spellCheck={false}
              data-autofocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
            />
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle chips; fieldset would add default chrome */}
          <div className="fp-filters" role="group" aria-label={t('fonts.category')}>
            {FONT_FILTERS.filter((f) => f !== 'custom' || (fonts.data?.length ?? 0) > 0).map((f) => (
              <button
                key={f}
                type="button"
                className="fp-filter"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {t(`fonts.cat.${f}`)}
              </button>
            ))}
          </div>
          <div ref={list} id={`${base}-list`} className="fp-list" role="listbox" aria-label={t('fonts.list')}>
            {shown.map((f, i) => (
              <div key={f.value} className="fp-row" role="presentation">
                <FontOption
                  font={f}
                  id={optionId(i)}
                  selected={f.value === value}
                  active={i === highlight}
                  onPick={() => pick(f)}
                />
                {f.custom && (
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={t('fonts.delete', { name: f.label })}
                    onClick={() => setRemoving(f)}
                  >
                    <Icon name="trash" size={16} />
                  </Button>
                )}
              </div>
            ))}
            {shown.length === 0 && <p className="muted fp-empty">{t('fonts.empty')}</p>}
          </div>
        </div>
      </Modal>

      <FontUploadDialog
        open={uploading}
        onClose={() => setUploading(false)}
        onUploaded={(f) => onChange(customFontRef(f.id))}
      />

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t('fonts.delete.title')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              {t('action.cancel')}
            </Button>
            <Button variant="danger" loading={del.isPending} onClick={() => void confirmRemove()}>
              {t('fonts.delete.confirm')}
            </Button>
          </>
        }
      >
        <p className="muted">{t('fonts.delete.body', { name: removing?.label ?? '' })}</p>
      </Modal>
    </>
  )
}
