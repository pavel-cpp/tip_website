import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useId, useMemo, useState } from 'react'
import { useCan } from '../../auth/guards'
import { Button } from '../../components/Button'
import { Panel } from '../../components/Panel'
import { Skeleton, useSkeleton } from '../../components/Skeleton'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import { useProjects } from '../projects/api'
import { getAuditPage, keys, listUsers } from './api'
import { AUDIT_ACTIONS, auditActionLabel, auditSentence } from './auditText'
import './admin.css'

interface FilterSelectProps {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}

function FilterSelect({ label, value, onChange, options }: FilterSelectProps) {
  const { t } = useI18n()
  const id = useId()
  return (
    <div className="field audit-filter">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="audit-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('admin.audit.filterAll')}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** Audit journal: readable sentences, raw data behind a disclosure, filters by user, action and project. */
export function AuditLog() {
  const { t, formatDate } = useI18n()
  const canProjects = useCan('project.view')
  const [actor, setActor] = useState('')
  const [action, setAction] = useState('')
  const [projectId, setProjectId] = useState('')

  const projects = useProjects()
  const titles = useMemo(
    () => (projects.data ? new Map(projects.data.map((p) => [p.id, p.title])) : null),
    [projects.data],
  )
  // The filter lists every account, not only the ones present in the loaded rows.
  const canUsers = useCan('user.view')
  const users = useQuery({ queryKey: keys.users, queryFn: listUsers, enabled: canUsers })
  const userNames = useMemo(
    () => (users.data ? new Map(users.data.map((u) => [u.user.id, u.user.displayName])) : null),
    [users.data],
  )

  const audit = useInfiniteQuery({
    queryKey: [...keys.audit, actor, projectId, action],
    queryFn: ({ pageParam }) =>
      getAuditPage(pageParam, {
        actor: actor || undefined,
        projectId: projectId || undefined,
        action: action || undefined,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  })
  const items = audit.data?.pages.flatMap((p) => p.items) ?? []
  const showSkeleton = useSkeleton(audit.isPending)

  const actorOptions = useMemo(() => {
    const byId = new Map<string, string>()
    for (const u of users.data ?? []) byId.set(u.user.id, u.user.login)
    // Without user.view the filter can only offer the accounts that appear in the loaded rows.
    for (const e of items) if (e.actorId && !byId.has(e.actorId)) byId.set(e.actorId, e.actorLogin)
    return [...byId]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [users.data, items])

  const filtered = actor !== '' || action !== '' || projectId !== ''

  return (
    <Panel title={t('admin.audit.title')} icon="list">
      <div className="audit-filters">
        <FilterSelect
          label={t('admin.audit.filterActor')}
          value={actor}
          onChange={setActor}
          options={actorOptions}
        />
        <FilterSelect
          label={t('admin.audit.filterAction')}
          value={action}
          onChange={setAction}
          options={AUDIT_ACTIONS.map((a) => ({ value: a, label: auditActionLabel(a) }))}
        />
        {canProjects && (
          <FilterSelect
            label={t('admin.audit.filterProject')}
            value={projectId}
            onChange={setProjectId}
            options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.title }))}
          />
        )}
      </div>

      {audit.isError && items.length === 0 ? (
        <div className="state-box" role="alert">
          <p>{errorText(audit.error)}</p>
          <Button onClick={() => void audit.refetch()}>{t('action.retry')}</Button>
        </div>
      ) : audit.isPending ? (
        <div className="table-skeleton" role="status" aria-label={t('state.loading')}>
          {showSkeleton && [0, 1, 2].map((i) => <Skeleton key={i} height={32} />)}
        </div>
      ) : items.length === 0 && !audit.hasNextPage ? (
        <p className="muted">{t(filtered ? 'admin.audit.filtered' : 'admin.audit.empty')}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th scope="col">{t('admin.audit.time')}</th>
                  <th scope="col">{t('admin.audit.details')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id}>
                    <td data-label={t('admin.audit.time')} className="nowrap">
                      {formatDate(new Date(e.at), { dateStyle: 'short', timeStyle: 'medium' })}
                    </td>
                    <td data-label={t('admin.audit.details')}>
                      <span className="audit-sentence">
                        {auditSentence(e, { projects: titles, users: userNames })}
                      </span>
                      <details className="audit-raw">
                        <summary>{t('admin.audit.raw')}</summary>
                        <pre className="audit-meta">
                          {JSON.stringify({ action: e.action, ...e.meta, ip: e.ip ?? undefined }, null, 2)}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {audit.hasNextPage && (
            <div className="load-more">
              <Button loading={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
                {t('admin.audit.more')}
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}
