import { describe, expect, it, vi } from 'vitest'
import { turnTicket } from './TicketPanel'

const fake = () => {
  const cancel = vi.fn()
  const animate = vi.fn(() => ({ cancel }) as unknown as Animation)
  return { el: { animate } as unknown as HTMLElement, animate }
}

describe('turnTicket', () => {
  it('swings the old ticket away and brings the new one from the other side, mirrored by direction', () => {
    for (const dir of [1, -1] as const) {
      const oldEl = fake()
      const newEl = fake()
      const anims = turnTicket(oldEl.el, newEl.el, dir)
      expect(anims).toHaveLength(2)
      const [oldFrames] = oldEl.animate.mock.calls[0] as unknown as [Keyframe[]]
      const [newFrames] = newEl.animate.mock.calls[0] as unknown as [Keyframe[]]
      // Next (dir 1): the old card leaves to the left and the new one comes from the right.
      expect(String(oldFrames[1]?.transform)).toContain(`translateX(${-14 * dir}%)`)
      expect(String(newFrames[0]?.transform)).toContain(`translateX(${14 * dir}%)`)
      expect(oldFrames[1]?.opacity).toBe(0)
      expect(newFrames[1]?.opacity).toBe(1)
    }
  })
})
