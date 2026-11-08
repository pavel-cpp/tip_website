import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { Can } from '../../auth/guards'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Panel } from '../../components/Panel'
import { Skeleton, useSkeleton } from '../../components/Skeleton'
import { getAuditPage, getSystem, keys, type SystemStatus } from '../../features/admin/api'
import { diskUsedRatio, splitBytes, splitUptime } from '../../features/admin/format'
import '../../features/admin/admin.css'
import { type MessageKey, useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import { cx } from '../../lib/cx'

type Check = SystemStatus['checks'][number]
const STATUS_TEXT: Record<Check['status'], MessageKey> = {
  ok: 'admin.system.status.ok',
  warn: 'admin.system.status.warn',
  fail: 'admin.system.status.fail',
}
const STATUS_ICON = { ok: 'check', warn: 'alert', fail: 'x' } as const

export default function System() {
  const { t } = useI18n()
  const system = useQuery({ queryKey: keys.system, queryFn: getSystem, refetchInterval: 30_000 })
  const showSkeleton = useSkeleton(system.isPending)

  return (
    <div className="admin-page">
      <div className="admin-head">
        <h1 className="page-title">{t('nav.adminSystem')}</h1>
        <div className="admin-tools">
          <Button
            size="sm"
            loading={system.isFetching && !system.isPending}
            onClick={() => void system.refetch()}
          >
            {t('admin.system.refresh')}
          </Button>
        </div>
      </div>

      {system.isError && !system.data ? (
        <div className="state-box" role="alert">
          <Icon name="alert" size={24} />
          <p>{errorText(system.error)}</p>
          <Button onClick={() => void system.refetch()}>{t('action.retry')}</Button>
        </div>
      ) : system.isPending ? (
        <div className="table-skeleton" role="status" aria-label={t('state.loading')}>
          {showSkeleton && [0, 1, 2].map((i) => <Skeleton key={i} height={72} radius={12} />)}
        </div>
      ) : system.data ? (
        <StatusView data={system.data} />
      ) : null}

      <Can perm="audit.view">
        <AuditLog />
      </Can>
    </div>
  )
}

function StatusView({ data }: { data: SystemStatus }) {
  const { t, formatNumber } = useI18n()
  const failing = data.checks.filter((c) => c.status === 'fail')
  const bytes = (n: number) => {
    const { value, unit } = splitBytes(n)
    return `${formatNumber(value)} ${t(`admin.unit.${unit}`)}`
  }
  const up = splitUptime(data.uptime)
  const used = diskUsedRatio(data.disk.free, data.disk.total)

  return (
    <>
      {failing.length > 0 && (
        <div className="banner banner-fail" role="alert">
          <Icon name="alert" size={20} />
          <div>
            <strong>{t('admin.system.failBanner', { count: failing.length })}</strong>
            <span className="banner-list">{failing.map((c) => c.name).join(', ')}</span>
          </div>
        </div>
      )}

      <Panel title={t('admin.system.checks')} icon="info">
        <ul className="checks">
          {data.checks.map((c, i) => (
            <li key={c.name} className="check row-enter" style={{ '--i': Math.min(i, 8) } as CSSProperties}>
              {/* The colour is never the only signal: icon and text carry the status as well. */}
              <span className="light" data-status={c.status}>
                <Icon name={STATUS_ICON[c.status]} size={14} />
              </span>
              <span className="check-main">
                <span className="check-title">{c.name}</span>
                {c.detail && <span className="muted check-detail">{c.detail}</span>}
              </span>
              <span className="check-status" data-status={c.status}>
                {t(STATUS_TEXT[c.status])}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="numbers">
        <Metric label={t('admin.system.version')} value={data.version} />
        <Metric
          label={t('admin.system.uptime')}
          value={t('admin.system.uptimeValue', { d: up.d, h: up.h, m: up.m })}
        />
        <Metric
          label={t('admin.system.db')}
          value={bytes(data.db.sizeBytes)}
          hint={t('admin.system.pool', {
            inUse: data.db.pool.inUse,
            open: data.db.pool.open,
            max: data.db.pool.maxOpen,
          })}
        />
        <Metric
          label={t('admin.system.disk')}
          value={t('admin.system.diskFree', { free: bytes(data.disk.free), total: bytes(data.disk.total) })}
          hint={`${formatNumber(Math.round(used * 100))}%`}
          bar={used}
        />
        <Metric
          label={t('admin.system.retention')}
          value={t('admin.system.retentionValue', {
            obs: data.retention.obsDays,
            audit: data.retention.auditDays,
          })}
        />
      </div>
    </>
  )
}

function Metric({ label, value, hint, bar }: { label: string; value: string; hint?: string; bar?: number }) {
  return (
    <div className="number">
      <span className="field-label">{label}</span>
      <span className="number-value">{value}</span>
      {hint && <span className="muted number-hint">{hint}</span>}
      {bar !== undefined && (
        <span className="meter" aria-hidden="true">
          <span
            className={cx('meter-fill', bar > 0.9 && 'meter-hot')}
            style={{ transform: `scaleX(${bar})` }}
          />
        </span>
      )}
    </div>
  )
}

function AuditLog() {
  const { t, formatDate } = useI18n()
  const audit = useInfiniteQuery({
    queryKey: keys.audit,
    queryFn: ({ pageParam }) => getAuditPage(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  })
  const items = audit.data?.pages.flatMap((p) => p.items) ?? []
  const showSkeleton = useSkeleton(audit.isPending)

  return (
    <Panel title={t('admin.audit.title')} icon="pencil">
      {audit.isError && items.length === 0 ? (
        <div className="state-box" role="alert">
          <p>{errorText(audit.error)}</p>
          <Button onClick={() => void audit.refetch()}>{t('action.retry')}</Button>
        </div>
      ) : audit.isPending ? (
        <div className="table-skeleton" role="status" aria-label={t('state.loading')}>
          {showSkeleton && [0, 1, 2].map((i) => <Skeleton key={i} height={32} />)}
        </div>
      ) : items.length === 0 ? (
        <p className="muted">{t('admin.audit.empty')}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th scope="col">{t('admin.audit.time')}</th>
                  <th scope="col">{t('admin.audit.actor')}</th>
                  <th scope="col">{t('admin.audit.action')}</th>
                  <th scope="col">{t('admin.audit.details')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id}>
                    <td data-label={t('admin.audit.time')} className="nowrap">
                      {formatDate(new Date(e.at), { dateStyle: 'short', timeStyle: 'medium' })}
                    </td>
                    <td data-label={t('admin.audit.actor')}>{e.actorLogin}</td>
                    <td data-label={t('admin.audit.action')}>
                      <code>{e.action}</code>
                    </td>
                    <td data-label={t('admin.audit.details')} className="muted audit-meta">
                      {Object.keys(e.meta).length > 0 ? JSON.stringify(e.meta) : ''}
                      {e.ip ? ` ${e.ip}` : ''}
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
