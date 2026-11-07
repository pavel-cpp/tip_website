import { type KeyboardEvent, type ReactNode, type Ref, useEffect, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import { Icon, type IconName } from './Icon'
import { Popover } from './Popover'
import { Tooltip } from './Tooltip'

export interface MenuItem {
  id: string
  label: string
  icon?: IconName
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** Shown as a tooltip on a disabled item. */
  disabledReason?: string
  /** When defined the item is a radio option and shows a check mark if true. */
  checked?: boolean
  separatorBefore?: boolean
}

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>
  onClick: () => void
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
}

interface MenuProps {
  label: string
  items: MenuItem[]
  trigger: (props: MenuTriggerProps) => ReactNode
  align?: 'start' | 'end'
}

export function Menu({ label, items, trigger, align = 'end' }: MenuProps) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const list = useRef<HTMLDivElement>(null)

  const buttons = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])]

  // Focus the checked or first item once the popover content exists.
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => {
      const all = buttons()
      ;(all.find((b) => b.getAttribute('aria-checked') === 'true') ?? all[0])?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [open])

  const onKeyDown = (e: KeyboardEvent) => {
    const all = buttons()
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    const move = (n: number) => {
      e.preventDefault()
      all[(n + all.length) % all.length]?.focus()
    }
    if (e.key === 'ArrowDown') move(i + 1)
    else if (e.key === 'ArrowUp') move(i - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(all.length - 1)
    else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <>
      {trigger({
        ref: setAnchor,
        onClick: () => setOpen((v) => !v),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
      })}
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        align={align}
        role="menu"
        label={label}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: roving focus is handled for the whole menu */}
        <div ref={list} onKeyDown={onKeyDown}>
          {items.map((item) => {
            const radio = item.checked !== undefined
            const button = (
              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked is set only for the menuitemradio role
              <button
                type="button"
                role={radio ? 'menuitemradio' : 'menuitem'}
                aria-checked={radio ? item.checked : undefined}
                aria-disabled={item.disabled || undefined}
                tabIndex={-1}
                className={cx('menu-item', item.danger && 'menu-item-danger')}
                onClick={() => {
                  if (item.disabled) return
                  setOpen(false)
                  anchor?.focus()
                  item.onSelect()
                }}
              >
                {item.icon && <Icon name={item.icon} />}
                {item.label}
                {item.checked && <Icon name="check" className="menu-check" />}
              </button>
            )
            return (
              <div key={item.id}>
                {item.separatorBefore && <hr className="menu-sep" />}
                {item.disabled && item.disabledReason ? (
                  <Tooltip content={item.disabledReason} side="bottom">
                    {button}
                  </Tooltip>
                ) : (
                  button
                )}
              </div>
            )
          })}
        </div>
      </Popover>
    </>
  )
}
