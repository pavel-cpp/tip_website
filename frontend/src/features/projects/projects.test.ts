import { describe, expect, it } from 'vitest'
import { ru } from '../../i18n/ru'
import { uz } from '../../i18n/uz'
import type { ProjectCardData } from './api'
import { buildPatch, changedKeys, clampInt, isDirty, normalizePlaceholder, toDraft } from './draft'
import { clampToImage, clientToImage, dragPosition, keyDelta, snapPosition, snapThreshold } from './drag'
import { deleteConfirmed, flipDelta, gradientFor, hueFor, projectActions, splitProjects } from './logic'
import { permissionsFromToken } from './usePermissions'

const card = (id: string, title: string, status: 'active' | 'finished' = 'active'): ProjectCardData => ({
  id,
  title,
  status,
  image: null,
  online: [],
  participantCount: 0,
})

describe('splitProjects', () => {
  const list = [card('1', 'Tashkent City'), card('2', 'Autumn iPhone'), card('3', 'Spring 2025', 'finished')]

  it('splits by status', () => {
    const s = splitProjects(list, '', true)
    expect(s.active.map((p) => p.id)).toEqual(['1', '2'])
    expect(s.finished.map((p) => p.id)).toEqual(['3'])
  })

  it('drops finished projects without project.view_finished', () => {
    expect(splitProjects(list, '', false).finished).toEqual([])
  })

  it('filters by a case-insensitive title query', () => {
    const s = splitProjects(list, '  city ', true)
    expect(s.active.map((p) => p.id)).toEqual(['1'])
    expect(s.finished).toEqual([])
  })
})

describe('projectActions (permission-filtered card menu)', () => {
  const as =
    (...perms: string[]) =>
    (p: string) =>
      perms.includes(p)

  it('offers everything to a full admin on an active project', () => {
    expect(projectActions(as('project.update', 'project.finish', 'project.delete'), 'active')).toEqual([
      'settings',
      'finish',
      'delete',
    ])
  })

  it('offers reopen instead of finish and no settings on a finished project', () => {
    expect(projectActions(as('project.update', 'project.finish', 'project.delete'), 'finished')).toEqual([
      'reopen',
      'delete',
    ])
  })

  it('shows nothing to a worker', () => {
    expect(projectActions(as('project.view'), 'active')).toEqual([])
  })

  it('shows only what is permitted', () => {
    expect(projectActions(as('project.finish'), 'active')).toEqual(['finish'])
  })
})

describe('delete confirmation', () => {
  it('requires the exact title', () => {
    expect(deleteConfirmed('Tashkent City', 'Tashkent City')).toBe(true)
    expect(deleteConfirmed(' Tashkent City ', 'Tashkent City')).toBe(true)
    expect(deleteConfirmed('tashkent city', 'Tashkent City')).toBe(false)
    expect(deleteConfirmed('', '')).toBe(false)
  })
})

describe('gradient and flip', () => {
  it('is deterministic per id and varies between ids', () => {
    expect(gradientFor('abc')).toBe(gradientFor('abc'))
    expect(hueFor('abc')).not.toBe(hueFor('abd'))
    expect(hueFor('abc')).toBeGreaterThanOrEqual(0)
    expect(hueFor('abc')).toBeLessThan(360)
  })

  it('computes the inverse translation and ignores sub-pixel moves', () => {
    expect(flipDelta({ left: 100, top: 50 }, { left: 40, top: 70 })).toEqual({ dx: 60, dy: -20 })
    expect(flipDelta({ left: 10, top: 10 }, { left: 10.4, top: 9.8 })).toBeNull()
  })
})

describe('permissions from token', () => {
  const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`
  it('reads the perms claim', () => {
    expect([...permissionsFromToken(jwt({ perms: ['project.view', 'project.create'] }))]).toEqual([
      'project.view',
      'project.create',
    ])
  })
  it('is empty for missing or malformed tokens', () => {
    expect(permissionsFromToken(null).size).toBe(0)
    expect(permissionsFromToken('garbage').size).toBe(0)
    expect(permissionsFromToken(jwt({})).size).toBe(0)
  })
})

describe('drag maths', () => {
  const image = { w: 1000, h: 500 }
  const rect = { left: 100, top: 50, width: 500, height: 250 }

  it('maps client coordinates to image pixels', () => {
    expect(clientToImage(350, 175, rect, image)).toEqual({ x: 500, y: 250 })
    expect(clientToImage(100, 50, rect, image)).toEqual({ x: 0, y: 0 })
    expect(clientToImage(1, 1, { ...rect, width: 0 }, image)).toEqual({ x: 0, y: 0 })
  })

  it('clamps into the image', () => {
    expect(clampToImage({ x: -5, y: 900 }, image)).toEqual({ x: 0, y: 500 })
    expect(clampToImage({ x: 10.6, y: 3.2 }, image)).toEqual({ x: 11, y: 3 })
  })

  it('keeps the grab offset so the chip does not jump', () => {
    expect(dragPosition({ x: 520, y: 260 }, { x: 20, y: 10 }, image)).toEqual({ x: 500, y: 250 })
  })

  it('snaps to the centre and edges within the threshold, per axis', () => {
    const near = snapPosition({ x: 503, y: 100 }, image, 8)
    expect(near.point).toEqual({ x: 500, y: 100 })
    expect(near.guides).toEqual({ x: 500, y: null })
    const edge = snapPosition({ x: 4, y: 497 }, image, 8)
    expect(edge.point).toEqual({ x: 0, y: 500 })
    expect(edge.guides).toEqual({ x: 0, y: 500 })
    expect(snapPosition({ x: 600, y: 100 }, image, 8).guides).toEqual({ x: null, y: null })
  })

  it('expresses 8 screen pixels in image pixels', () => {
    expect(snapThreshold(1000, 500)).toBe(16)
    expect(snapThreshold(1000, 0)).toBe(0)
  })

  it('maps arrow keys to 1 px or 10 px steps', () => {
    expect(keyDelta('ArrowLeft', false)).toEqual({ x: -1, y: 0 })
    expect(keyDelta('ArrowDown', true)).toEqual({ x: 0, y: 10 })
    expect(keyDelta('Enter', false)).toBeNull()
  })
})

describe('settings draft', () => {
  const ph = (over = {}) => ({
    font: 'Montserrat',
    size: 34,
    stroke: 2,
    color: '#FFFFFF',
    strokeColor: '#141619',
    bold: true,
    italic: false,
    underline: false,
    x: 512,
    y: 340,
    ...over,
  })
  const project = {
    title: 'A',
    version: 4,
    placeholders: { number: ph(), name: ph(), phone: ph() },
  }

  it('is clean for an untouched draft and detects edits', () => {
    const d = toDraft(project)
    expect(isDirty(d, project)).toBe(false)
    d.placeholders.name.x = 10
    expect(isDirty(d, project)).toBe(true)
    expect(changedKeys(d, project)).toEqual(['name'])
  })

  it('compares colours case-insensitively', () => {
    const d = toDraft(project)
    d.placeholders.number.color = '#ffffff'
    expect(isDirty(d, project)).toBe(false)
  })

  it('builds a minimal PATCH with the version', () => {
    const d = toDraft(project)
    expect(buildPatch(d, project)).toEqual({ version: 4 })
    d.title = ' B '
    d.placeholders.phone.size = 40
    expect(buildPatch(d, project)).toEqual({
      version: 4,
      title: 'B',
      placeholders: { phone: { ...ph(), size: 40 } },
    })
  })

  it('normalises values into the backend limits', () => {
    const p = normalizePlaceholder(ph({ size: 2, stroke: 99, x: -4, y: 9999 }), { w: 1000, h: 500 })
    expect([p.size, p.stroke, p.x, p.y]).toEqual([6, 50, 0, 500])
    expect(clampInt(7.6, 0, 10)).toBe(8)
  })
})

describe('i18n parity for the projects namespaces', () => {
  const prefixed = (d: Record<string, unknown>) =>
    Object.keys(d).filter((k) => /^(projects|settings|ticket|fonts)\./.test(k))

  it('has the same keys in ru and uz', () => {
    expect(prefixed(uz).sort()).toEqual(prefixed(ru).sort())
    expect(prefixed(ru).length).toBeGreaterThan(40)
  })
})
