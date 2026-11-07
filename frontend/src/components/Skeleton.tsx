import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { cx } from '../lib/cx'

const SHOW_AFTER = 200
const MIN_VISIBLE = 300

/**
 * Tells whether to render skeletons for a loading state: false for the first 200 ms (fast loads never
 * flash a placeholder) and, once shown, kept for at least 300 ms so it does not blink away.
 */
export function useSkeleton(loading: boolean): boolean {
  const [visible, setVisible] = useState(false)
  const shownAt = useRef(0)

  useEffect(() => {
    if (loading) {
      const id = setTimeout(() => {
        shownAt.current = Date.now()
        setVisible(true)
      }, SHOW_AFTER)
      return () => clearTimeout(id)
    }
    if (!visible) return
    const left = Math.max(0, MIN_VISIBLE - (Date.now() - shownAt.current))
    const id = setTimeout(() => setVisible(false), left)
    return () => clearTimeout(id)
  }, [loading, visible])

  return visible
}

interface SkeletonProps {
  width?: CSSProperties['width']
  height?: CSSProperties['height']
  radius?: CSSProperties['borderRadius']
  className?: string
}

/** Shimmer placeholder. It also hides itself via CSS for 200 ms, so it is safe to mount while loading. */
export function Skeleton({ width = '100%', height = 16, radius, className }: SkeletonProps) {
  return (
    <span
      className={cx('skeleton', className)}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  )
}
