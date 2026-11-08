import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import { UserAvatar } from '../../auth/UserAvatar'
import { useI18n } from '../../i18n'
import type { Peer } from './protocol'
import { useRealtime } from './RealtimeProvider'
import './realtime.css'

const LEAVE_MS = 200
const MAX_SHOWN = 4

interface Shown {
  peer: Peer
  leaving: boolean
}

/** Colleagues online right now; avatars pop in and out as they come and go. */
export function OnlineAvatars() {
  const rt = useRealtime()
  const { t } = useI18n()
  const you = rt?.snapshot.you
  const peers = rt?.snapshot.peers
  const others = useMemo(() => (peers ?? []).filter((p) => p.id !== you), [peers, you])
  const [shown, setShown] = useState<Shown[]>([])
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const current = new Map(others.map((p) => [p.id, p]))
    setShown((prev) => {
      const known = new Set(prev.map((s) => s.peer.id))
      const kept = prev.map((s) => {
        const peer = current.get(s.peer.id)
        return peer ? { peer, leaving: false } : { ...s, leaving: true }
      })
      return [...kept, ...others.filter((p) => !known.has(p.id)).map((peer) => ({ peer, leaving: false }))]
    })
    // Leaving avatars are dropped once their exit animation is over.
    const id = setTimeout(() => {
      timers.current.delete(id)
      setShown((prev) => prev.filter((s) => !s.leaving))
    }, LEAVE_MS)
    timers.current.add(id)
  }, [others])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const id of pending) clearTimeout(id)
    }
  }, [])

  if (shown.length === 0) return null
  const visible = shown.slice(0, MAX_SHOWN)
  const extra = shown.filter((s) => !s.leaving).length - visible.filter((s) => !s.leaving).length
  return (
    <ul className="rt-online" aria-label={t('realtime.online.label', { count: others.length })}>
      {visible.map(({ peer, leaving }) => (
        <li key={peer.id} className="rt-online-item" data-leaving={leaving || undefined}>
          <UserAvatar user={peer} size={26} />
        </li>
      ))}
      {extra > 0 && (
        <li className="rt-online-item rt-online-more" style={{ '--size': '26px' } as CSSProperties}>
          +{extra}
        </li>
      )}
    </ul>
  )
}

/** Quiet pill that only appears while the connection is down. */
export function ConnectionBadge() {
  const rt = useRealtime()
  const { t } = useI18n()
  const state = rt?.state
  if (state !== 'reconnecting' && state !== 'offline') return null
  return (
    <span className="rt-conn" data-state={state} role="status">
      <span className="rt-conn-dot" aria-hidden="true" />
      {t(state === 'offline' ? 'realtime.conn.offline' : 'realtime.conn.reconnecting')}
    </span>
  )
}
