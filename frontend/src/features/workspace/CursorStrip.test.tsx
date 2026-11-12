import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CursorStrip } from './CursorStrip'

const peer = (i: number) => ({ id: `u${i}`, displayName: `User ${i}`, color: '#3ddc97' })

describe('CursorStrip', () => {
  it('renders nothing without cursors', () => {
    const { container } = render(<CursorStrip cursors={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('draws one segment per colleague and names them all in the tooltip', () => {
    const { container } = render(<CursorStrip cursors={[peer(1), peer(2)]} />)
    expect(container.querySelectorAll('.pt-cursor')).toHaveLength(2)
    expect(container.querySelector('.pt-cursors')).toHaveAttribute('title', 'User 1, User 2')
  })

  it('keeps ten colleagues inside the strip: at most eight segments, all names in the tooltip', () => {
    const many = Array.from({ length: 10 }, (_, i) => peer(i + 1))
    const { container } = render(<CursorStrip cursors={many} />)
    expect(container.querySelectorAll('.pt-cursor')).toHaveLength(8)
    expect(container.querySelector('.pt-cursors')?.getAttribute('title')).toContain('User 10')
  })
})
