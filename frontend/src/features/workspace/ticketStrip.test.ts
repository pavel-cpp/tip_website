import { describe, expect, it, vi } from 'vitest'
import { EASE } from '../../lib/motion'
import { neighbourAt, runLegs, slideDuration } from './ticketStrip'

describe('ticket strip', () => {
  it('takes about 290 ms for a full-width slide without a release speed, less for a short one', () => {
    expect(slideDuration(400, 400)).toBe(290)
    expect(slideDuration(200, 400)).toBe(245)
    expect(slideDuration(0, 400, 2)).toBe(200)
  })

  it('continues a fast flick at its release speed (shorter than the plain slide, never abrupt)', () => {
    expect(slideDuration(300, 400, 6)).toBeLessThan(slideDuration(300, 400))
    expect(slideDuration(300, 400, 20)).toBe(160)
    // A hesitant release uses the plain duration.
    expect(slideDuration(300, 400, 0.1)).toBe(slideDuration(300, 400))
  })

  it('keeps the neighbour one picture width behind, on the side of travel', () => {
    expect(neighbourAt(0, 1, 400)).toBe(400)
    expect(neighbourAt(-120, 1, 400)).toBe(280)
    expect(neighbourAt(90, -1, 400)).toBe(-310)
  })

  it('moves the legs together with one timing and only transform', () => {
    const el = () => {
      const animate = vi.fn(() => ({}) as unknown as Animation)
      return { el: { animate } as unknown as HTMLElement, animate }
    }
    const out = el()
    const inn = el()
    runLegs(
      [
        { el: out.el, from: -40, to: -400 },
        { el: inn.el, from: 360, to: 0 },
      ],
      280,
    )
    const [outFrames, outOpts] = out.animate.mock.calls[0] as unknown as [
      Keyframe[],
      KeyframeAnimationOptions,
    ]
    const [inFrames, inOpts] = inn.animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions]
    expect(outFrames.map((f) => f.transform)).toEqual(['translateX(-40px)', 'translateX(-400px)'])
    expect(inFrames.map((f) => f.transform)).toEqual(['translateX(360px)', 'translateX(0px)'])
    for (const f of [...outFrames, ...inFrames]) expect(Object.keys(f)).toEqual(['transform'])
    expect([outOpts.duration, inOpts.duration]).toEqual([280, 280])
    expect([outOpts.easing, inOpts.easing]).toEqual([EASE.out, EASE.out])
    expect(outOpts.delay).toBeUndefined()
  })
})
