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
}

export function Panel({ title, icon, actions, children, className }: PanelProps) {
  return (
    <section className={cx('panel', className)}>
      <header className="panel-head">
        {icon && <Icon name={icon} />}
        <h2 className="panel-title">{title}</h2>
        {actions}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}
