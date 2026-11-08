import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/styles/tokens.css', 'utf8') // vitest runs from frontend/

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`selector not found: ${selector}`)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]?.trim() ?? '']),
  )
}

const themes = { dark: block('[data-theme="dark"]'), light: block('[data-theme="light"]') }

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

// [foreground token, background tokens, minimum ratio]
const PAIRS: Array<[string, string[], number]> = [
  ['text', ['bg', 'bg-elev', 'bg-input', 'bg-hover'], 4.5],
  ['text-muted', ['bg', 'bg-elev', 'bg-input'], 4.5],
  ['text-faint', ['bg-elev', 'bg-input'], 4.5],
  ['accent-text', ['bg', 'bg-elev'], 4.5],
  ['danger', ['bg', 'bg-elev'], 4.5],
  ['ok', ['bg', 'bg-elev'], 4.5],
  ['accent-contrast', ['accent'], 4.5],
  ['accent', ['bg-elev', 'bg-input'], 3],
  ['user-1', ['bg-elev'], 3],
  ['user-2', ['bg-elev'], 3],
  ['user-3', ['bg-elev'], 3],
  ['user-4', ['bg-elev'], 3],
  ['user-5', ['bg-elev'], 3],
  ['user-6', ['bg-elev'], 3],
]

describe.each(Object.entries(themes))('%s theme contrast (WCAG AA)', (_name, tokens) => {
  it.each(PAIRS.flatMap(([fg, bgs, min]) => bgs.map((bg) => [fg, bg, min] as const)))(
    '%s on %s >= %s',
    (fg, bg, min) => {
      expect(ratio(tokens[fg] as string, tokens[bg] as string)).toBeGreaterThanOrEqual(min)
    },
  )
})

describe.each(Object.entries(themes))('%s theme outlines (WCAG 1.4.11)', (_name, tokens) => {
  // Field, secondary button and card borders must be visible against what they sit on.
  it.each(['bg', 'bg-elev', 'bg-input'])('border-strong on %s >= 3', (bg) => {
    expect(ratio(tokens['border-strong'] as string, tokens[bg] as string)).toBeGreaterThanOrEqual(3)
  })
})

it('both themes define the same colour tokens', () => {
  expect(Object.keys(themes.light).sort()).toEqual(Object.keys(themes.dark).sort())
})
