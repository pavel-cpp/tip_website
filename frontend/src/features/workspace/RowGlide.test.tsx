import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CardLayer, CurrentMark, selectionRuns, UnderLayer } from './RowGlide'

const ids = ['a', 'b', 'c', 'd', 'e', 'f']

describe('selectionRuns', () => {
  it('is empty without a selection', () => {
    expect(selectionRuns(ids, new Set())).toEqual([])
  })

  it('merges neighbours into one run and splits at gaps', () => {
    expect(selectionRuns(ids, new Set(['b', 'c', 'e']))).toEqual([
      { start: 1, len: 2 },
      { start: 4, len: 1 },
    ])
  })

  it('ignores selected ids that are not in the list', () => {
    expect(selectionRuns(ids, new Set(['zzz']))).toEqual([])
  })
})

describe('UnderLayer and CurrentMark', () => {
  it('position everything with transform so moving the selection is a glide', () => {
    const { container } = render(
      <>
        <UnderLayer runs={[{ start: 2, len: 3 }]} spot={{ index: 1, color: '#ff0000' }} rowHeight={44} />
        <CurrentMark index={2} rowHeight={44} />
      </>,
    )
    expect(container.querySelector<HTMLElement>('.pt-band')?.style.transform).toBe(
      'translateY(88px) scaleY(132)',
    )
    expect(container.querySelector<HTMLElement>('.pt-spot')?.style.transform).toBe('translateY(44px)')
    expect(container.querySelector<HTMLElement>('.pt-curmark')?.style.transform).toBe('translateY(96px)')
  })

  it('falls back to the accent for a colour that is not a plain hex', () => {
    const { container } = render(<UnderLayer runs={[]} spot={{ index: 0, color: 'red;}' }} rowHeight={44} />)
    expect(container.querySelector<HTMLElement>('.pt-spot')?.style.getPropertyValue('--spot')).toBe(
      'var(--accent)',
    )
  })

  it('draws no marker without a current row', () => {
    const { container } = render(<CurrentMark index={null} rowHeight={44} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('CardLayer', () => {
  it('places the marker and the followed card with transform, one element each', () => {
    const { container } = render(
      <CardLayer
        hilite={{ y: 100, h: 76 }}
        mark={{ y: 110, h: 40 }}
        spot={{ y: 100, h: 76, color: '#00ff00' }}
      />,
    )
    const mark = container.querySelector<HTMLElement>('.pc-curmark')
    expect(mark?.style.transform).toBe('translateY(110px)')
    expect(mark?.style.height).toBe('40px')
    expect(container.querySelector<HTMLElement>('.pc-hilite')?.style.transform).toBe('translateY(100px)')
    const spot = container.querySelector<HTMLElement>('.pc-spot')
    expect(spot?.style.transform).toBe('translateY(100px)')
    expect(spot?.style.getPropertyValue('--spot')).toBe('#00ff00')
  })

  it('keeps the same marker element when the current card changes', () => {
    const { container, rerender } = render(
      <CardLayer hilite={{ y: 0, h: 60 }} mark={{ y: 10, h: 40 }} spot={null} />,
    )
    const before = container.querySelector('.pc-curmark')
    rerender(<CardLayer hilite={{ y: 84, h: 60 }} mark={{ y: 94, h: 40 }} spot={null} />)
    expect(container.querySelector('.pc-curmark')).toBe(before)
    expect(container.querySelector<HTMLElement>('.pc-curmark')?.style.transform).toBe('translateY(94px)')
    expect(container.querySelector<HTMLElement>('.pc-hilite')?.style.transform).toBe('translateY(84px)')
  })
})
