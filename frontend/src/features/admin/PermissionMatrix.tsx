import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import type { Permission, PermissionCode } from './api'
import { groupLabel, permissionHint, permissionLabel } from './labels'
import { dependenciesOf, togglePermission } from './permissions'
import './admin.css'

export const FLASH_MS = 600

interface Props {
  catalog: Permission[]
  value: ReadonlySet<PermissionCode>
  onChange: (next: Set<PermissionCode>) => void
  readOnly?: boolean
}

/** Checkbox matrix grouped by area. Enabling a permission switches its dependencies on and flashes them. */
export function PermissionMatrix({ catalog, value, onChange, readOnly = false }: Props) {
  const { t } = useI18n()
  const [flash, setFlash] = useState<ReadonlySet<PermissionCode>>(new Set())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const groups = useMemo(() => {
    const byGroup = new Map<string, Permission[]>()
    for (const p of catalog) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p])
    return [...byGroup]
  }, [catalog])

  function toggle(code: PermissionCode) {
    const { next, added } = togglePermission(value, code)
    onChange(next)
    clearTimeout(timer.current)
    setFlash(new Set(added))
    if (added.length > 0) timer.current = setTimeout(() => setFlash(new Set()), FLASH_MS)
  }

  return (
    <div className="matrix">
      {groups.map(([group, perms]) => (
        <fieldset key={group} className="matrix-group" disabled={readOnly}>
          <legend className="matrix-legend">{groupLabel(group)}</legend>
          {perms.map((p) => {
            const deps = dependenciesOf(p.code)
            const on = value.has(p.code)
            return (
              <label key={p.code} className="perm-row" data-flash={flash.has(p.code) || undefined}>
                <input
                  type="checkbox"
                  className="perm-box"
                  checked={on}
                  onChange={() => toggle(p.code)}
                  data-code={p.code}
                />
                <span className="perm-text">
                  <span className="perm-name">{permissionLabel(p.code, p.code)}</span>
                  <span className="perm-desc">{permissionHint(p.code, p.description)}</span>
                  {deps.length > 0 && (
                    <span className="perm-deps">
                      {t('admin.roles.requires', { list: deps.map((d) => permissionLabel(d)).join(', ') })}
                    </span>
                  )}
                </span>
                {flash.has(p.code) && <span className="perm-auto">{t('admin.roles.autoAdded')}</span>}
              </label>
            )
          })}
        </fieldset>
      ))}
    </div>
  )
}
