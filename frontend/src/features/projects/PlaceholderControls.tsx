import { useEffect, useId, useState } from 'react'
import { Button } from '../../components/Button'
import { useI18n } from '../../i18n'
import { PLACEHOLDER_LIMITS, type TicketPlaceholder } from '../../lib/ticket'
import { clampInt, isHexColor } from './draft'
import { FontPicker } from './FontPicker'
import './settings.css'

interface NumberFieldProps {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  stepper?: boolean
  disabled?: boolean
}

/**
 * Integer field. While typing, only in-range values are committed (so "3" on the way to "34" does
 * not jump to the minimum); the text is normalised on blur.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  stepper = true,
  disabled,
}: NumberFieldProps) {
  const { t } = useI18n()
  const id = useId()
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])

  const commit = (raw: string) => {
    setText(raw)
    const n = Number(raw)
    if (raw.trim() !== '' && Number.isInteger(n) && n >= min && n <= max) onChange(n)
  }
  const step = (d: number) => onChange(clampInt(value + d, min, max))

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="input num-field">
        {stepper && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            disabled={disabled || value <= min}
            aria-label={`${t('settings.decrease')}: ${label}`}
            onClick={() => step(-1)}
          >
            −
          </Button>
        )}
        <input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          value={text}
          disabled={disabled}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => {
            const n = Number(text)
            const fixed = text.trim() === '' || !Number.isFinite(n) ? value : clampInt(n, min, max)
            setText(String(fixed))
            if (fixed !== value) onChange(fixed)
          }}
        />
        {stepper && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            disabled={disabled || value >= max}
            aria-label={`${t('settings.increase')}: ${label}`}
            onClick={() => step(1)}
          >
            +
          </Button>
        )}
      </div>
    </div>
  )
}

function ColorField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const id = useId()
  const [text, setText] = useState(value.toUpperCase())
  useEffect(() => setText(value.toUpperCase()), [value])
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="input color-field">
        <input
          type="color"
          className="color-swatch"
          aria-label={label}
          value={isHexColor(value) ? value.toLowerCase() : '#000000'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
        <input
          id={id}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`
            setText(v)
            if (isHexColor(v)) onChange(v.toUpperCase())
          }}
          onBlur={() => setText(value.toUpperCase())}
        />
      </div>
    </div>
  )
}

interface Props {
  value: TicketPlaceholder
  image: { w: number; h: number }
  onChange: (patch: Partial<TicketPlaceholder>) => void
  disabled?: boolean
}

export function PlaceholderControls({ value: p, image, onChange, disabled }: Props) {
  const { t } = useI18n()
  const styleId = useId()
  const { minSize, maxSize, minStroke, maxStroke } = PLACEHOLDER_LIMITS
  const toggles = [
    { key: 'bold', short: t('settings.boldShort'), label: t('settings.bold') },
    { key: 'italic', short: t('settings.italicShort'), label: t('settings.italic') },
    { key: 'underline', short: t('settings.underlineShort'), label: t('settings.underline') },
  ] as const

  return (
    <div className="ph-controls">
      <FontPicker
        label={t('settings.font')}
        value={p.font}
        disabled={disabled}
        onChange={(font) => onChange({ font })}
      />
      <div className="ph-row">
        <NumberField
          label={t('settings.size')}
          value={p.size}
          min={minSize}
          max={maxSize}
          disabled={disabled}
          onChange={(size) => onChange({ size })}
        />
        <NumberField
          label={t('settings.stroke')}
          value={p.stroke}
          min={minStroke}
          max={maxStroke}
          disabled={disabled}
          onChange={(stroke) => onChange({ stroke })}
        />
      </div>
      <div className="ph-row">
        <ColorField
          label={t('settings.color')}
          value={p.color}
          disabled={disabled}
          onChange={(color) => onChange({ color })}
        />
        <ColorField
          label={t('settings.strokeColor')}
          value={p.strokeColor}
          disabled={disabled}
          onChange={(strokeColor) => onChange({ strokeColor })}
        />
      </div>
      <div className="field">
        <span className="field-label" id={styleId}>
          {t('settings.style')}
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: a styled button group; fieldset would add default chrome */}
        <div className="style-toggles" role="group" aria-labelledby={styleId}>
          {toggles.map(({ key, short, label }) => (
            <button
              key={key}
              type="button"
              className="style-toggle"
              data-style={key}
              aria-pressed={p[key]}
              aria-label={label}
              title={label}
              disabled={disabled}
              onClick={() => onChange({ [key]: !p[key] })}
            >
              {short}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">{t('settings.position')}</span>
        <div className="ph-row">
          <NumberField
            label={t('settings.x')}
            value={p.x}
            min={0}
            max={image.w}
            stepper={false}
            disabled={disabled}
            onChange={(x) => onChange({ x })}
          />
          <NumberField
            label={t('settings.y')}
            value={p.y}
            min={0}
            max={image.h}
            stepper={false}
            disabled={disabled}
            onChange={(y) => onChange({ y })}
          />
        </div>
        <span className="field-hint">{t('settings.nudgeHint')}</span>
      </div>
    </div>
  )
}
