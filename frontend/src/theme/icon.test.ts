import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyTheme, iconHref } from './theme'

beforeEach(() => {
  document.head.innerHTML = '<link rel="icon" href="/favicon.svg">'
})

describe('tab icon', () => {
  it('uses the OS-adaptive file for system and a fixed one for an explicit theme', () => {
    expect(iconHref('system', 'dark')).toBe('/favicon.svg')
    expect(iconHref('dark', 'dark')).toBe('/favicon-dark.svg')
    expect(iconHref('light', 'light')).toBe('/favicon-light.svg')
  })

  it('applyTheme swaps the link href', () => {
    applyTheme('light')
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/favicon-light.svg')
    applyTheme('dark')
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/favicon-dark.svg')
    applyTheme('system')
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/favicon.svg')
  })

  it('the pre-paint script mirrors the same file names', () => {
    const src = readFileSync('public/theme-init.js', 'utf8')
    expect(src).toContain("'/favicon.svg'")
    expect(src).toMatch(/favicon-\$\{theme\}\.svg/)
  })
})
