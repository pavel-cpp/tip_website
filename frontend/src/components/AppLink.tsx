import type { ComponentProps } from 'react'
import { Link } from 'react-router'
import { prefetchRoute } from '../routes'

/** Router link that warms the next screen's chunk on hover/focus and uses a View Transition when supported. */
export function AppLink({ to, ...rest }: ComponentProps<typeof Link> & { to: string }) {
  const warm = () => prefetchRoute(to)
  return <Link to={to} onPointerEnter={warm} onFocus={warm} {...rest} />
}
