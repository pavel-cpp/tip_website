import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { hexToHsv, hsvToHex } from './colorMath'

/** Colours that read well on a ticket picture; the first two are the usual text/outline pair. */
export const PRESET_COLORS = [
  '#FFFFFF',
  '#000000',
  '#FFD400',
  '#FF8A00',
  '#E5322D',
  '#E91E8C',
  '#8E44AD',
  '#1F5FE0',
  '#00A3E0',
  '#00A86B',
  '#7CB518',
  '#8A8F9C',
] as const

interface Props {
  value: string
  onChange: (hex: string) => void
  disabled?: boolean
}

/**
 * Colour picker that lives in the page flow instead of the browser's native pop-up: a saturation/brightness
 * square, a hue slider and a row of ready-made colours. Hue is kept apart from the hex value so dragging
 * through grey does not lose it.
 */
export function ColorPicker({ value, onChange, disabled }: Props) {
  const { t } = useI18n()
  const hsv = hexToHsv(value)
  const [hue, setHue] = useState(hsv.h)
  const square = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  // A colour that was typed or picked from the presets drives the hue; otherwise the slider does.
  const shownHue = hsv.s === 0 || hsv.v === 0 ? hue : hsv.h

  const emit = (h: number, s: number, v: number) => onChange(hsvToHex({ h, s, v }))
  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = square.current?.getBoundingClientRect()
    if (!r || r.width === 0 || r.height === 0) return
    const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))
    emit(shownHue, s, v)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }
    const move = d[e.key]
    if (!move) return
    e.preventDefault()
    emit(shownHue, Math.min(1, Math.max(0, hsv.s + move[0])), Math.min(1, Math.max(0, hsv.v + move[1])))
  }

  return (
    <div className="cp" data-disabled={disabled || undefined}>
      <div
        ref={square}
        className="cp-square"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={t('settings.colorShade')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.v * 100)}
        aria-valuetext={t('settings.colorShadeValue', {
          s: Math.round(hsv.s * 100),
          v: Math.round(hsv.v * 100),
        })}
        aria-disabled={disabled || undefined}
        style={{ '--cp-hue': shownHue } as React.CSSProperties}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return
          dragging.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          pick(e)
        }}
        onPointerMove={(e) => dragging.current && pick(e)}
        onPointerUp={(e) => {
          dragging.current = false
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId)
        }}
        onPointerCancel={() => {
          dragging.current = false
        }}
        onKeyDown={onKey}
      >
        <span
          className="cp-knob"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value }}
        />
      </div>
      <input
        type="range"
        className="cp-hue"
        min={0}
        max={359}
        value={Math.round(shownHue) % 360}
        disabled={disabled}
        aria-label={t('settings.colorHue')}
        onChange={(e) => {
          const h = Number(e.target.value)
          setHue(h)
          // Pure grey/black keep their value; the hue is remembered for the next drag.
          if (hsv.s > 0 && hsv.v > 0) emit(h, hsv.s, hsv.v)
        }}
      />
      {/* biome-ignore lint/a11y/useSemanticElements: a plain button grid; fieldset would add default chrome */}
      <div className="cp-presets" role="group" aria-label={t('settings.colorPresets')}>
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className="cp-preset"
            aria-label={c}
            title={c}
            aria-pressed={value.toUpperCase() === c}
            disabled={disabled}
            style={{ background: c }}
            onClick={() => {
              onChange(c)
              setHue(hexToHsv(c).h)
            }}
          />
        ))}
      </div>
    </div>
  )
}
