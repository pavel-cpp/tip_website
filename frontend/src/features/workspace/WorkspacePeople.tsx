import { type CSSProperties, useMemo } from 'react'
import { UserAvatar } from '../../auth/UserAvatar'
import { Tooltip } from '../../components/Tooltip'
import { useI18n } from '../../i18n'
import { useRealtime } from '../realtime/RealtimeProvider'

const MAX_SHOWN = 5

export interface Contributor {
  id: string
  displayName: string
  color: string
  avatarUrl: string | null
  /** The row this person edited last; null when none remains. */
  lastRowId?: string | null
}

interface Person extends Contributor {
  online: boolean
}

interface WorkspacePeopleProps {
  contributors: readonly Contributor[]
  /** The colleague currently being watched. */
  watchedId: string | null
  /** A click on someone who is online: go to what they are doing now. */
  onSelectOnline: (id: string) => void
  /** A click on someone who is away: go to the row they edited last. */
  onSelectLastRow: (rowId: string) => void
}

/** Everyone who has worked in the project: colleagues online (green dot) first, then the rest. */
export function WorkspacePeople({
  contributors,
  watchedId,
  onSelectOnline,
  onSelectLastRow,
}: WorkspacePeopleProps) {
  const { t } = useI18n()
  const rt = useRealtime()
  const you = rt?.snapshot.you
  const peers = rt?.snapshot.peers
  const people = useMemo<Person[]>(() => {
    const online = (peers ?? [])
      .filter((p) => p.id !== you)
      .map((p) => ({ ...p, lastRowId: null, online: true }))
    const seen = new Set(online.map((p) => p.id))
    // A colleague who just arrived may not be in the project's contributor list yet; the live peer wins.
    const away = contributors
      .filter((c) => c.id !== you && !seen.has(c.id))
      .map((c) => ({ ...c, online: false }))
    return [...online, ...away]
  }, [peers, you, contributors])

  if (people.length === 0) return null
  const visible = people.slice(0, MAX_SHOWN)
  const hidden = people.slice(MAX_SHOWN)
  const onlineCount = people.filter((p) => p.online).length
  return (
    <ul
      className="rt-online"
      data-testid="people-list"
      aria-label={t('realtime.online.label', { count: onlineCount })}
    >
      {visible.map((p) => {
        const lastRowId = p.lastRowId ?? null
        const target = p.online ? p.id : lastRowId
        const label = p.online
          ? t('realtime.follow.jump', { name: p.displayName })
          : t(lastRowId ? 'workspace.people.jumpLast' : 'workspace.people.noEdits', { name: p.displayName })
        return (
          <li key={p.id} className="rt-online-item">
            <Tooltip content={p.displayName} side="bottom">
              <button
                type="button"
                className="rt-online-btn"
                data-online={p.online || undefined}
                aria-pressed={p.online ? watchedId === p.id : undefined}
                aria-label={label}
                aria-disabled={!target || undefined}
                style={{ '--peer': p.color } as CSSProperties}
                onClick={() => {
                  if (!target) return
                  if (p.online) onSelectOnline(p.id)
                  else onSelectLastRow(target)
                }}
              >
                <UserAvatar user={p} size={28} noTitle />
                {p.online && <span className="rt-online-dot" aria-hidden="true" />}
              </button>
            </Tooltip>
          </li>
        )
      })}
      {hidden.length > 0 && (
        <li className="rt-online-item">
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
