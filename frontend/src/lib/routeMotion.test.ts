import { describe, expect, it } from 'vitest'
import {
  blocksOf,
  invert,
  keyWanted,
  leaveTo,
  navDirection,
  projectIdOf,
  radiusAt,
  revealFrom,
  routeRank,
} from './routeMotion'

describe('route direction', () => {
  it('ranks the project hierarchy and leaves other screens unranked', () => {
    expect(routeRank('/')).toBe(0)
    expect(routeRank('/projects/abc')).toBe(1)
    expect(routeRank('/projects/abc/settings')).toBe(2)
    expect(routeRank('/profile')).toBeNull()
    expect(projectIdOf('/projects/abc/settings')).toBe('abc')
    expect(projectIdOf('/')).toBeNull()
  })

  it('goes in when deeper, out when shallower, and slides along the menu order between siblings', () => {
    expect(navDirection('/', '/projects/1').kind).toBe('in')
    expect(navDirection('/projects/1', '/projects/1/settings').kind).toBe('in')
    expect(navDirection('/projects/1/settings', '/projects/1').kind).toBe('out')
    expect(navDirection('/projects/1', '/').kind).toBe('out')
    expect(navDirection('/login', '/').kind).toBe('in')
    expect(navDirection('/', '/profile')).toEqual({ kind: 'side', sign: 1 })
    expect(navDirection('/admin/roles', '/admin/users')).toEqual({ kind: 'side', sign: -1 })
    expect(navDirection('/projects/1', '/projects/2').kind).toBe('side')
  })

  it('reveals and leaves per direction without any 3D motion', () => {
    expect(revealFrom({ kind: 'in', sign: 1 })).toBe('translateY(16px)')
    expect(revealFrom({ kind: 'out', sign: 1 })).toBe('translateY(-8px)')
    expect(revealFrom({ kind: 'side', sign: -1 })).toBe('translateX(-18px)')
    expect(leaveTo({ kind: 'in', sign: 1 })).toBe('scale(0.985)')
    expect(leaveTo({ kind: 'side', sign: 1 })).toBe('translateX(-14px)')
    for (const k of ['in', 'out', 'side'] as const) {
      expect(revealFrom({ kind: k, sign: 1 })).not.toMatch(/rotate|perspective|3d/)
    }
  })
})

describe('flight maths', () => {
  it('inverts a box so that it appears where the old one was', () => {
    expect(invert({ x: 10, y: 20, w: 100, h: 50 }, { x: 110, y: 120, w: 400, h: 200 })).toEqual({
      dx: -100,
      dy: -100,
      sx: 0.25,
      sy: 0.25,
    })
    expect(invert({ x: 0, y: 0, w: 5, h: 5 }, { x: 0, y: 0, w: 0, h: 0 })).toEqual({
      dx: 0,
      dy: 0,
      sx: 1,
      sy: 1,
    })
  })

  it('keeps the corner radius constant on screen while the box is stretched', () => {
    expect(radiusAt(18, 0.25, 0.5)).toBe('72.00px / 36.00px')
    expect(radiusAt(18, 1, 1)).toBe('18.00px / 18.00px')
    expect(radiusAt(18, 0, 0)).toBe('18.00px / 18.00px')
  })

  it('only considers marks of the projects involved', () => {
    expect(keyWanted('heading', ['a'])).toBe(true)
    expect(keyWanted('title:a', ['a', null])).toBe(true)
    expect(keyWanted('title:b', ['a', null])).toBe(false)
    expect(keyWanted('hero:a', [null, null])).toBe(false)
  })
})

describe('blocks of a page', () => {
  const page = (html: string) => {
    const main = document.createElement('main')
    main.innerHTML = html
    document.body.appendChild(main)
    return main
  }

  it('descends through single wrappers and returns the first level with several children', () => {
    const main = page('<div><form><header></header><section></section><footer></footer></form></div>')
    expect(blocksOf(main).map((b) => b.tagName)).toEqual(['HEADER', 'SECTION', 'FOOTER'])
    main.remove()
  })

  it('caps the number of blocks and skips hidden ones', () => {
    const main = page('<h1></h1><p hidden></p><p></p><p></p><p></p><p></p><p></p><p></p>')
    const blocks = blocksOf(main)
    expect(blocks).toHaveLength(5)
    expect(blocks.some((b) => b.hidden)).toBe(false)
    main.remove()
  })
})
