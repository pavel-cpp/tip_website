import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import { Icon, type IconName } from './Icon'

interface PanelProps {
  title: string
  icon?: IconName
  /** Buttons aligned to the right of the header. */
  actions?: ReactNode
  children?: ReactNode
  className?: string
  /** The panel slides in from the side when its page opens (lib/routeMotion.ts). */
  reveal?: 'side'
}

export function Panel({ title, icon, actions, children, className, reveal }: PanelProps) {
  return (
    <section className={cx('panel', className)} data-reveal={reveal}>
      <header className="panel-head">
        {icon && <Icon name={icon} />}
        <h2 className="panel-title">{title}</h2>
        {actions}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}
