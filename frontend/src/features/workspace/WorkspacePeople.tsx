import { type CSSProperties, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { UserAvatar } from '../../auth/UserAvatar'
import { Tooltip } from '../../components/Tooltip'
import { useI18n } from '../../i18n'
import { useRealtime } from '../realtime/RealtimeProvider'
import '../realtime/realtime.css'

const MAX_SHOWN = 6
/** The phone top bar also holds the language, theme and user buttons, so it fits fewer avatars. */
const MAX_SHOWN_PHONE = 3
/** Two clicks on one colleague this close together are a double click (tap), which starts following. */
const DOUBLE_CLICK_MS = 400
/** Phones and tablets have no hover: the first tap on the stack spreads it, the next tap picks someone. */
const NO_HOVER = '(hover: none)'
const PHONE = '(max-width: 699px), (orientation: landscape) and (max-height: 500px)'

function subscribePhone(cb: () => void) {
  if (typeof matchMedia !== 'function') return () => {}
  const mq = matchMedia(PHONE)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const noHover = () => typeof matchMedia === 'function' && matchMedia(NO_HOVER).matches
const isPhone = () => typeof matchMedia === 'function' && matchMedia(PHONE).matches

interface WorkspacePeopleProps {
  /** The colleague the view is following right now. */
  followingId: string | null
  /** Following needs the permission; without it a double click does nothing more than a click. */
  canFollow: boolean
  /** A click on a colleague: go to what they are doing now. */
  onSelectOnline: (id: string) => void
  /** A double click on a colleague: start following them. */
  onFollow: (id: string) => void
}

/** The colleagues who are in the project right now, as a stack of avatars that spreads on hover or tap. */
export function WorkspacePeople({ followingId, canFollow, onSelectOnline, onFollow }: WorkspacePeopleProps) {
  const { t } = useI18n()
  const rt = useRealtime()
  const you = rt?.snapshot.you
  const peers = rt?.snapshot.peers
  const lastClick = useRef<{ id: string; at: number } | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!listRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  const phone = useSyncExternalStore(subscribePhone, isPhone, () => false)
  // Only people who are connected to this project: nobody who is away or offline is listed.
  const people = useMemo(() => (peers ?? []).filter((p) => p.id !== you), [peers, you])

  const max = phone ? MAX_SHOWN_PHONE : MAX_SHOWN
  if (people.length === 0) return null
  const visible = people.slice(0, max)
  const hidden = people.slice(max)
  return (
    <ul
      ref={listRef}
      className="rt-online"
      data-open={open || undefined}
      // Number of avatars in the stack, for the plate that fades in behind them when it spreads.
      style={{ '--n': visible.length + (hidden.length > 0 ? 1 : 0) } as CSSProperties}
      data-testid="people-list"
      aria-label={t('realtime.online.label', { count: people.length })}
    >
      {visible.map((p, index) => {
        const label = t('realtime.follow.jump', { name: p.displayName })
        const tip = canFollow ? `${p.displayName} · ${t('workspace.people.followHint')}` : p.displayName
        return (
          <li
            key={p.id}
            className="rt-online-item"
            // How many places the avatar sits from the end of the stack; the spread shifts it by that many steps.
            style={{ '--k': visible.length + (hidden.length > 0 ? 1 : 0) - 1 - index } as CSSProperties}
          >
            <Tooltip content={tip} side="bottom">
              <button
                type="button"
                className="rt-online-btn"
                aria-pressed={canFollow ? followingId === p.id : undefined}
                aria-label={label}
                style={{ '--peer': p.color } as CSSProperties}
                onClick={() => {
                  // With no hover the stack must be opened first, or a tap would pick whoever lies on top.
                  if (!open && noHover() && people.length > 1) {
                    setOpen(true)
                    return
                  }
                  const now = Date.now()
                  const prev = lastClick.current
                  if (canFollow && prev?.id === p.id && now - prev.at < DOUBLE_CLICK_MS) {
                    lastClick.current = null
                    onFollow(p.id)
                    return
                  }
                  lastClick.current = { id: p.id, at: now }
                  onSelectOnline(p.id)
                }}
              >
                <UserAvatar user={p} size={28} noTitle />
              </button>
            </Tooltip>
          </li>
        )
      })}
      {hidden.length > 0 && (
        <li className="rt-online-item" style={{ '--k': 0 } as CSSProperties}>
          <Tooltip content={hidden.map((p) => p.displayName).join(', ')} side="bottom">
            <span className="rt-online-more" style={{ '--size': '28px' } as CSSProperties}>
              +{hidden.length}
            </span>
          </Tooltip>
        </li>
      )}
    </ul>
  )
}
