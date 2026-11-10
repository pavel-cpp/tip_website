import { describe, expect, it } from 'vitest'
import { navKind, routeRank } from './viewTransition'

describe('route transition direction', () => {
  it('ranks the project hierarchy and leaves other screens unranked', () => {
    expect(routeRank('/')).toBe(0)
    expect(routeRank('/projects/abc')).toBe(1)
    expect(routeRank('/projects/abc/settings')).toBe(2)
    expect(routeRank('/profile')).toBeNull()
    expect(routeRank('/admin/users')).toBeNull()
  })

  it('drills in going deeper, goes back going shallower, and treats the rest as siblings', () => {
    expect(navKind('/', '/projects/1')).toBe('drill')
    expect(navKind('/projects/1', '/projects/1/settings')).toBe('drill')
    expect(navKind('/projects/1/settings', '/projects/1')).toBe('back')
    expect(navKind('/projects/1', '/')).toBe('back')
    expect(navKind('/', '/profile')).toBe('sibling')
    expect(navKind('/admin/users', '/admin/roles')).toBe('sibling')
    expect(navKind('/projects/1', '/projects/2')).toBe('sibling')
  })
})
