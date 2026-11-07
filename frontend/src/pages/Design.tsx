import { type ReactNode, useRef, useState } from 'react'
import { Avatar, AvatarStack } from '../components/Avatar'
import { Button } from '../components/Button'
import { ICON_NAMES, Icon } from '../components/Icon'
import { Input, PasswordInput } from '../components/Input'
import { Menu } from '../components/Menu'
import { Modal } from '../components/Modal'
import { Panel } from '../components/Panel'
import { Skeleton } from '../components/Skeleton'
import { Tabs } from '../components/Tabs'
import { useToast } from '../components/Toast'
import { Tooltip } from '../components/Tooltip'
import { useI18n } from '../i18n'
import { loadMotion, prefersReducedMotion, SPRING, useReduceMotionSetting } from '../lib/motion'

const USERS = [
  { id: '1', displayName: 'Azam Xudoyberdiyev', color: '#ff6b9d' },
  { id: '2', displayName: 'Шахзод Б', color: '#ffb84d' },
  { id: '3', displayName: 'Dilnoza Rahimova', color: '#3ddc97' },
  { id: '4', displayName: 'Фаррух Т', color: '#6cb4ff' },
  { id: '5', displayName: 'Bobur Aliyev', color: '#b18cff' },
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <h3 className="field-label">{title}</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        {children}
      </div>
    </section>
  )
}

function SpringDemo() {
  const { t } = useI18n()
  const box = useRef<HTMLSpanElement>(null)
  const run = async () => {
    if (prefersReducedMotion() || !box.current) return
    // The animation library is fetched on first use, not with the initial bundle.
    const { animate } = await loadMotion()
    animate(
      box.current,
      { x: [0, 120, 0] },
      { type: 'spring', stiffness: SPRING.stiffness, damping: SPRING.damping },
    )
  }
  return (
    <>
      <Button onClick={run}>{t('design.motion.bounce')}</Button>
      <span
        ref={box}
        className="avatar"
        style={{ '--size': '32px', '--c': 'var(--accent)' } as React.CSSProperties}
      />
    </>
  )
}

function Gallery() {
  const { t } = useI18n()
  const toast = useToast()
  const [modal, setModal] = useState(false)
  const [tab, setTab] = useState('one')
  const [loading, setLoading] = useState(false)
  const tabs = [
    { id: 'one', label: t('design.tabs.one') },
    { id: 'two', label: t('design.tabs.two') },
    { id: 'three', label: t('design.tabs.three') },
  ]

  return (
    <div style={{ display: 'grid', gap: 'var(--space-6)' }}>
      <Section title={t('design.section.buttons')}>
        <Button variant="primary">{t('design.button.primary')}</Button>
        <Button>{t('design.button.secondary')}</Button>
        <Button variant="ghost">{t('design.button.ghost')}</Button>
        <Button variant="danger">
          <Icon name="trash" />
          {t('design.button.danger')}
        </Button>
        <Button
          variant="primary"
          loading={loading}
          onClick={() => {
            setLoading(true)
            setTimeout(() => setLoading(false), 1500)
          }}
        >
          {t('design.button.loading')}
        </Button>
        <Button disabled disabledReason={t('design.button.disabledReason')}>
          {t('design.button.disabled')}
        </Button>
        <Button iconOnly aria-label={t('action.more')}>
          <Icon name="more" />
        </Button>
      </Section>

      <Section title={t('design.section.inputs')}>
        <div style={{ display: 'grid', gap: 'var(--space-3)', width: 'min(320px, 100%)' }}>
          <Input
            label={t('design.input.label')}
            icon="user"
            hint={t('design.input.hint')}
            autoComplete="off"
          />
          <Input
            label={t('design.input.label')}
            icon="user"
            error={t('design.input.error')}
            defaultValue="…"
          />
          <PasswordInput label={t('auth.login.password')} />
        </div>
      </Section>

      <Section title={t('design.section.overlays')}>
        <Button onClick={() => setModal(true)}>{t('design.modal.open')}</Button>
        <Modal
          open={modal}
          onClose={() => setModal(false)}
          title={t('design.modal.title')}
          actions={
            <>
              <Button onClick={() => setModal(false)}>{t('action.cancel')}</Button>
              <Button variant="primary" onClick={() => setModal(false)}>
                {t('action.confirm')}
              </Button>
            </>
          }
        >
          <p className="muted">{t('design.modal.body')}</p>
        </Modal>
        <Menu
          label={t('design.menu.open')}
          align="start"
          items={[
            { id: 'a', label: t('design.menu.item1'), icon: 'pencil', onSelect: () => {} },
            { id: 'b', label: t('design.menu.item2'), icon: 'check', onSelect: () => {} },
            {
              id: 'c',
              label: t('action.delete'),
              icon: 'trash',
              danger: true,
              separatorBefore: true,
              onSelect: () => {},
            },
          ]}
          trigger={(p) => (
            <Button {...p}>
              {t('design.menu.open')}
              <Icon name="chevronDown" />
            </Button>
          )}
        />
        <Tooltip content={t('design.tooltip.text')}>
          <Button>{t('design.tooltip.target')}</Button>
        </Tooltip>
      </Section>

      <Section title={t('design.section.toast')}>
        <Button onClick={() => toast.show({ message: t('design.toast.text') })}>
          {t('design.toast.show')}
        </Button>
        <Button
          onClick={() =>
            toast.show({
              message: t('toast.rowsDeleted', { count: 3 }),
              action: { label: t('action.undo'), onAction: () => {} },
            })
          }
        >
          {t('design.toast.undoable')}
        </Button>
        <Button onClick={() => toast.show({ message: t('errors.NETWORK'), tone: 'error' })}>
          {t('errors.NETWORK')}
        </Button>
      </Section>

      <Section title={t('design.section.skeleton')}>
        <div style={{ display: 'grid', gap: 8, width: 280 }}>
          <Skeleton height={20} width="60%" />
          <Skeleton height={14} />
          <Skeleton height={14} width="85%" />
          <span className="field-hint">{t('design.skeleton.hint')}</span>
        </div>
      </Section>

      <Section title={t('design.section.avatars')}>
        <Avatar user={USERS[0] as (typeof USERS)[number]} size={36} />
        <AvatarStack users={USERS} max={3} />
      </Section>

      <Section title={t('design.section.tabs')}>
        <div style={{ width: 'min(420px, 100%)' }}>
          <Tabs tabs={tabs} value={tab} onChange={setTab} label={t('design.section.tabs')} />
        </div>
      </Section>

      <Section title={t('design.section.panel')}>
        <Panel
          title={t('design.panel.title')}
          icon="settings"
          className="design-panel"
          actions={
            <Button size="sm" variant="ghost" iconOnly aria-label={t('action.close')}>
              <Icon name="x" />
            </Button>
          }
        >
          <p className="muted">{t('design.panel.body')}</p>
        </Panel>
      </Section>

      <Section title={t('design.section.motion')}>
        <SpringDemo />
      </Section>

      <Section title={t('design.section.icons')}>
        {ICON_NAMES.map((n) => (
          <Tooltip key={n} content={n}>
            <span
              style={{
                display: 'grid',
                placeItems: 'center',
                width: 36,
                height: 36,
                color: 'var(--text-muted)',
              }}
            >
              <Icon name={n} size={20} />
            </span>
          </Tooltip>
        ))}
      </Section>
    </div>
  )
}

/** Visual-check page: every component, optionally dark and light side by side. */
export default function Design() {
  const { t } = useI18n()
  const [both, setBoth] = useState(false)
  const [reduce, setReduce] = useReduceMotionSetting()

  return (
    <>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-4)',
        }}
      >
        <h1 className="page-title" style={{ marginBottom: 0, flex: 1 }}>
          {t('design.title')}
        </h1>
        <Button
          aria-pressed={both}
          aria-label={`${t('theme.dark')} / ${t('theme.light')}`}
          onClick={() => setBoth((v) => !v)}
        >
          <Icon name="moon" />
          <Icon name="sun" />
        </Button>
        <Button aria-pressed={reduce} onClick={() => setReduce(!reduce)}>
          {t('appearance.reduceMotion')}
        </Button>
      </div>
      {both ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
            gap: 'var(--space-4)',
          }}
        >
          {(['dark', 'light'] as const).map((theme) => (
            <div
              key={theme}
              data-theme={theme}
              style={{
                background: 'var(--bg)',
                color: 'var(--text)',
                padding: 'var(--space-4)',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border)',
              }}
            >
              <Gallery />
            </div>
          ))}
        </div>
      ) : (
        <Gallery />
      )}
    </>
  )
}
