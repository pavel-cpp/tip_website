import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { UserAvatar } from '../auth/UserAvatar'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Input } from '../components/Input'
import { useToast } from '../components/Toast'
import { ChangePasswordForm } from '../features/auth/ChangePasswordForm'
import { checkAvatarFile, deleteAvatar, USER_COLORS, updateMe, uploadAvatar } from '../features/profile/api'
import { Segmented } from '../features/profile/Segmented'
import '../features/profile/profile.css'
import { LOCALES, type Locale, useI18n } from '../i18n'
import { errorText } from '../i18n/apiError'
import { cx } from '../lib/cx'
import { useReduceMotionSetting } from '../lib/motion'
import { THEME_MODES, type ThemeMode, useTheme } from '../theme/theme'

const THEME_ICON = { dark: 'moon', light: 'sun', system: 'monitor' } as const

export default function Profile() {
  const { t, locale, setLocale } = useI18n()
  const { user, setUser } = useAuth()
  const toast = useToast()
  const theme = useTheme()
  const [reduceMotion, setReduceMotion] = useReduceMotionSetting()

  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [color, setColor] = useState(user?.color ?? USER_COLORS[3])
  const [nameError, setNameError] = useState<string>()
  const [saving, setSaving] = useState(false)

  const [preview, setPreview] = useState<string | null>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarError, setAvatarError] = useState<string>()
  const fileInput = useRef<HTMLInputElement>(null)

  // Release the object URL of a preview once it is replaced or the screen closes.
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview) : undefined), [preview])

  if (!user) return null
  const dirty = displayName.trim() !== user.displayName || color !== user.color

  async function save(e: FormEvent) {
    e.preventDefault()
    const name = displayName.trim()
    if (!name) {
      setNameError(t('validation.required'))
      return
    }
    setNameError(undefined)
    setSaving(true)
    try {
      setUser(await updateMe({ displayName: name, color }))
      toast.show({ message: t('profile.saved') })
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    if (!user) return
    setDisplayName(user.displayName)
    setColor(user.color)
    setNameError(undefined)
  }

  async function pickAvatar(file: File | undefined) {
    if (!file) return
    const problem = checkAvatarFile(file)
    if (problem) {
      setAvatarError(t(`errors.${problem}`))
      return
    }
    setAvatarError(undefined)
    setPreview(URL.createObjectURL(file))
    setAvatarBusy(true)
    try {
      setUser(await uploadAvatar(file))
    } catch (err) {
      setAvatarError(errorText(err))
    } finally {
      setAvatarBusy(false)
      setPreview(null)
    }
  }

  async function removeAvatar() {
    setAvatarError(undefined)
    setAvatarBusy(true)
    try {
      setUser(await deleteAvatar())
    } catch (err) {
      setAvatarError(errorText(err))
    } finally {
      setAvatarBusy(false)
    }
  }

  // Applied at once on this device, then stored on the server so other devices follow.
  async function persistPreference(patch: { locale: Locale } | { theme: ThemeMode }) {
    try {
      setUser(await updateMe(patch))
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }

  return (
    <div className="profile">
      <h1 className="page-title">{t('profile.title')}</h1>

      <form className="profile-card" onSubmit={save} noValidate>
        <section className="profile-avatar" aria-labelledby="profile-photo">
          <UserAvatar user={{ ...user, color }} size={64} override={preview} />
          <div className="profile-avatar-body">
            <h2 id="profile-photo" className="profile-section-title">
              {t('profile.photo')}
            </h2>
            <div className="profile-avatar-actions">
              <Button size="sm" loading={avatarBusy} onClick={() => fileInput.current?.click()}>
                {t('profile.photoChange')}
              </Button>
              {user.avatarUrl && (
                <Button size="sm" variant="ghost" disabled={avatarBusy} onClick={() => void removeAvatar()}>
                  {t('profile.photoDelete')}
                </Button>
              )}
              <input
                ref={fileInput}
                type="file"
                className="sr-only"
                tabIndex={-1}
                aria-label={t('profile.photoChange')}
                accept="image/png,image/jpeg"
                onChange={(e) => {
                  void pickAvatar(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </div>
            {avatarError ? (
              <p className="form-error" role="alert">
                {avatarError}
              </p>
            ) : (
              <p className="field-hint">{t('profile.photoHint')}</p>
            )}
          </div>
        </section>

        <Input
          label={t('profile.displayName')}
          name="displayName"
          autoComplete="name"
          value={displayName}
          error={nameError}
          onChange={(e) => setDisplayName(e.target.value)}
        />

        <div className="field">
          <span className="field-label" id="profile-color">
            {t('profile.color')}
          </span>
          <div className="swatches" role="radiogroup" aria-labelledby="profile-color">
            {USER_COLORS.map((c, i) => (
              // biome-ignore lint/a11y/useSemanticElements: styled colour swatch radio
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === color}
                aria-label={t('profile.colorOption', { n: i + 1 })}
                className={cx('swatch', c === color && 'swatch-on')}
                style={{ '--c': c } as CSSProperties}
                onClick={() => setColor(c)}
              >
                <Icon name="check" size={16} />
              </button>
            ))}
          </div>
          <span className="field-hint">{t('profile.colorHint')}</span>
        </div>

        <div className="profile-actions">
          <Button variant="ghost" disabled={!dirty || saving} onClick={cancel}>
            {t('action.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
            {t('profile.save')}
          </Button>
        </div>
      </form>

      <section className="profile-card" aria-labelledby="profile-password">
        <h2 id="profile-password" className="profile-section-title">
          {t('auth.password.title')}
        </h2>
        <ChangePasswordForm />
      </section>

      <section className="profile-card" aria-labelledby="profile-appearance">
        <h2 id="profile-appearance" className="profile-section-title">
          {t('profile.appearance')}
        </h2>
        <Segmented
          label={t('language.title')}
          value={locale}
          options={LOCALES.map((l) => ({ value: l, label: t(`language.${l}`) }))}
          onChange={(l) => {
            void setLocale(l)
            void persistPreference({ locale: l })
          }}
        />
        <Segmented
          label={t('theme.title')}
          value={theme.mode}
          options={THEME_MODES.map((m) => ({
            value: m,
            label: t(`theme.${m}`),
            icon: <Icon name={THEME_ICON[m]} size={16} />,
          }))}
          onChange={(m) => {
            theme.setMode(m)
            void persistPreference({ theme: m })
          }}
        />
        <label className="switch-row">
          <span>
            <span className="switch-title">{t('appearance.reduceMotion')}</span>
            <span className="field-hint">{t('profile.reduceMotionHint')}</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-checked={reduceMotion}
            className="switch"
            checked={reduceMotion}
            onChange={(e) => setReduceMotion(e.target.checked)}
          />
        </label>
      </section>
    </div>
  )
}
