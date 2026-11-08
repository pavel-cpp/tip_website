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

type Rgb = [number, number, number]

/** Parses #rrggbb or rgba(r, g, b, a); returns the colour and its alpha. */
function parse(value: string): { rgb: Rgb; a: number } {
  if (value.startsWith('#')) {
    const n = Number.parseInt(value.slice(1), 16)
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], a: 1 }
  }
  const m = value.match(/rgba?\(([^)]+)\)/)
  if (!m) throw new Error(`unsupported colour: ${value}`)
  const [r = 0, g = 0, b = 0, a = 1] = (m[1] as string).split(',').map((x) => Number.parseFloat(x))
  return { rgb: [r, g, b], a }
}

/** Resolves a token over an opaque backdrop token (alpha tokens such as accent-soft are blended). */
function over(tokens: Record<string, string>, fg: string, backdrop: string): Rgb {
  const top = parse(tokens[fg] as string)
  const base = parse(tokens[backdrop] as string).rgb
  return top.rgb.map((c, i) => Math.round(c * top.a + (base[i] as number) * (1 - top.a))) as Rgb
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

// Every surface text or a control can sit on. accent-soft is translucent and is blended over bg-elev,
// the surface it is used on (selected rows, chips).
const SURFACES = ['bg', 'bg-elev', 'bg-input', 'bg-hover', 'accent-soft'] as const
const TEXT = ['text', 'text-muted', 'text-faint', 'accent-text', 'danger', 'ok'] as const
const GRAPHIC = [
  'accent',
  'border-strong',
  'user-1',
  'user-2',
  'user-3',
  'user-4',
  'user-5',
  'user-6',
] as const

const surface = (t: Record<string, string>, name: string): Rgb =>
  name === 'accent-soft' ? over(t, name, 'bg-elev') : over(t, name, 'bg')

describe.each(Object.entries(themes))(
  '%s theme: text on every surface (WCAG 1.4.3, >= 4.5)',
  (_n, tokens) => {
    it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)))('%s on %s', (fg, bg) => {
      expect(ratio(over(tokens, fg, 'bg'), surface(tokens, bg))).toBeGreaterThanOrEqual(4.5)
    })

    it.each([
      ['accent-contrast', 'accent'],
      ['accent-contrast', 'accent-hover'],
    ] as const)('button label %s on %s', (fg, bg) => {
      expect(ratio(over(tokens, fg, 'bg'), over(tokens, bg, 'bg'))).toBeGreaterThanOrEqual(4.5)
    })
  },
)

describe.each(Object.entries(themes))(
  '%s theme: icons, outlines and cursors on every surface (WCAG 1.4.11, >= 3)',
  (_n, tokens) => {
    it.each(GRAPHIC.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)))('%s on %s', (fg, bg) => {
      expect(ratio(over(tokens, fg, 'bg'), surface(tokens, bg))).toBeGreaterThanOrEqual(3)
    })

    it('the primary button fill stands out from the page', () => {
      expect(ratio(over(tokens, 'accent', 'bg'), over(tokens, 'bg', 'bg'))).toBeGreaterThanOrEqual(3)
    })
  },
)

it('both themes define the same colour tokens', () => {
  expect(Object.keys(themes.light).sort()).toEqual(Object.keys(themes.dark).sort())
})
