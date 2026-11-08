import { useI18n } from '../../i18n'
import type { Role } from './api'
import './admin.css'

interface Props {
  label: string
  roles: Role[]
  selected: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  error?: string
}

/** Multi-select of roles as a checkbox list (no popup: it is shown inside dialogs). */
export function RoleChecklist({ label, roles, selected, onChange, error }: Props) {
  const { t } = useI18n()
  return (
    <fieldset className="check-list">
      <legend className="field-label">{label}</legend>
      {roles.map((r) => (
        <label key={r.id} className="check-row">
          <input
            type="checkbox"
            checked={selected.has(r.id)}
            onChange={() => {
              const next = new Set(selected)
              if (!next.delete(r.id)) next.add(r.id)
              onChange(next)
            }}
          />
          <span className="check-name">{r.name}</span>
          {r.isSystem && <span className="badge">{t('admin.roles.system')}</span>}
        </label>
      ))}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </fieldset>
  )
}
