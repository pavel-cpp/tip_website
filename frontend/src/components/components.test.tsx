import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Avatar, AvatarStack, initials, textOn } from './Avatar'
import { Button } from './Button'
import { Input, PasswordInput } from './Input'
import { Menu } from './Menu'
import { Modal } from './Modal'
import { Panel } from './Panel'
import { Skeleton, useSkeleton } from './Skeleton'
import { Tabs } from './Tabs'
import { ToastProvider, useToast } from './Toast'
import { Tooltip } from './Tooltip'

afterEach(() => vi.useRealTimers())

describe('Button', () => {
  it('fires onClick', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Go</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('blocks clicks and marks itself busy while loading', async () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    )
    const b = screen.getByRole('button', { name: 'Save' })
    expect(b).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(b)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('stays focusable when unavailable and explains why in a tooltip', async () => {
    const onClick = vi.fn()
    render(
      <Button disabled disabledReason="Project is finished" onClick={onClick}>
        Edit
      </Button>,
    )
    const b = screen.getByRole('button', { name: 'Edit' })
    expect(b).toHaveAttribute('aria-disabled', 'true')
    await userEvent.tab()
    expect(b).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Project is finished')
    await userEvent.keyboard('{Enter}')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('does not submit a form while loading', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Send
        </Button>
      </form>,
    )
    await userEvent.click(screen.getByRole('button'))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('Input', () => {
  it('links label, hint and error to the field', () => {
    render(<Input label="Name" error="Required" />)
    const input = screen.getByLabelText('Name')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Required')
    expect(screen.getByRole('alert')).toHaveTextContent('Required')
  })

  it('PasswordInput toggles visibility with a localised label', async () => {
    render(<PasswordInput label="Password" />)
    const input = screen.getByLabelText('Password')
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: 'Показать пароль' }))
    expect(input).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Скрыть пароль' })).toHaveAttribute('aria-pressed', 'true')
  })
})

function ModalHarness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <Modal
        open={open}
        title="Title"
        onClose={() => {
          onClose()
          setOpen(false)
        }}
        actions={<Button>OK</Button>}
      >
        <input aria-label="field" />
      </Modal>
    </>
  )
}

describe('Modal', () => {
  it('opens as a labelled modal dialog, moves focus in, traps Tab', async () => {
    render(<ModalHarness />)
    await userEvent.click(screen.getByText('open'))
    const dialog = screen.getByRole('dialog', { name: 'Title' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const field = screen.getByLabelText('field')
    expect(field).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus()
    await userEvent.tab()
    expect(field).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus()
  })

  it('closes on Escape and on backdrop press, then restores focus', async () => {
    const onClose = vi.fn()
    render(<ModalHarness onClose={onClose} />)
    const opener = screen.getByText('open')
    await userEvent.click(opener)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()

    await userEvent.click(opener)
    fireEvent.pointerDown(screen.getByRole('presentation'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('Menu', () => {
  const setup = (onSelect = vi.fn()) => {
    render(
      <Menu
        label="Actions"
        items={[
          { id: 'a', label: 'Alpha', onSelect },
          { id: 'b', label: 'Beta', onSelect: vi.fn(), checked: true },
          { id: 'c', label: 'Gamma', onSelect: vi.fn(), disabled: true },
        ]}
        trigger={(p) => <Button {...p}>Menu</Button>}
      />,
    )
    return onSelect
  }

  it('opens from the trigger, focuses the checked item and supports arrow keys', async () => {
    setup()
    const trigger = screen.getByRole('button', { name: 'Menu' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu', { name: 'Actions' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Beta' })).toHaveFocus())
    await userEvent.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Gamma' })).toHaveFocus()
  })

  it('selects with Enter, closes and returns focus to the trigger', async () => {
    const onSelect = setup()
    const trigger = screen.getByRole('button', { name: 'Menu' })
    await userEvent.click(trigger)
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Beta' })).toHaveFocus())
    await userEvent.keyboard('{ArrowUp}{Enter}')
    expect(onSelect).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('ignores disabled items and closes on Escape', async () => {
    const onSelect = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Gamma' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(onSelect).not.toHaveBeenCalled()
  })
})

function ToastHarness({ onUndo }: { onUndo: () => void }) {
  const toast = useToast()
  return (
    <button
      type="button"
      onClick={() =>
        toast.show({ message: 'Deleted 3', action: { label: 'Undo', onAction: onUndo }, duration: 5000 })
      }
    >
      show
    </button>
  )
}

describe('Toast', () => {
  it('announces politely, runs the undo action and dismisses', async () => {
    const onUndo = vi.fn()
    render(
      <ToastProvider>
        <ToastHarness onUndo={onUndo} />
      </ToastProvider>,
    )
    await userEvent.click(screen.getByText('show'))
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByText('Deleted 3')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onUndo).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText('Deleted 3')).not.toBeInTheDocument())
  })

  it('auto-dismisses after its duration and pauses while hovered', () => {
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <ToastHarness onUndo={() => {}} />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('show'))
    const toast = screen.getByText('Deleted 3').closest('.toast') as HTMLElement
    expect(toast.querySelector('.toast-bar')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(3000))
    fireEvent.pointerEnter(toast)
    act(() => vi.advanceTimersByTime(10000))
    expect(screen.getByText('Deleted 3')).toBeInTheDocument()
    expect(toast).toHaveAttribute('data-paused', 'true')

    fireEvent.pointerLeave(toast)
    act(() => vi.advanceTimersByTime(1900))
    expect(screen.getByText('Deleted 3')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(200 + 200))
    expect(screen.queryByText('Deleted 3')).not.toBeInTheDocument()
  })
})

describe('Skeleton', () => {
  it('useSkeleton shows only after 200 ms and stays for at least 300 ms', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ loading }) => useSkeleton(loading), {
      initialProps: { loading: true },
    })
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(199))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(2))
    expect(result.current).toBe(true)

    act(() => vi.advanceTimersByTime(100))
    rerender({ loading: false })
    act(() => vi.advanceTimersByTime(150))
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(60))
    expect(result.current).toBe(false)
  })

  it('never shows for a fast load', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ loading }) => useSkeleton(loading), {
      initialProps: { loading: true },
    })
    act(() => vi.advanceTimersByTime(100))
    rerender({ loading: false })
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current).toBe(false)
  })

  it('renders a hidden-from-AT shimmer block', () => {
    const { container } = render(<Skeleton height={10} />)
    expect(container.firstElementChild).toHaveClass('skeleton')
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('Tabs', () => {
  it('moves selection with arrow keys and keeps a roving tabindex', async () => {
    const onChange = vi.fn()
    function Harness() {
      const [v, setV] = useState('a')
      return (
        <Tabs
          label="t"
          value={v}
          onChange={(id) => {
            onChange(id)
            setV(id)
          }}
          tabs={[
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ]}
        />
      )
    }
    render(<Harness />)
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('tabindex', '-1')
    await userEvent.tab()
    await userEvent.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith('b')
    expect(screen.getByRole('tab', { name: 'B' })).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('Avatar', () => {
  it('shows initials and picks a readable text colour', () => {
    expect(initials('Azam Xudoyberdiyev')).toBe('AX')
    expect(initials('  шахзод ')).toBe('Ш')
    expect(textOn('#ffb84d')).toBe('#101218')
    expect(textOn('#1a65b8')).toBe('#ffffff')
    render(<Avatar user={{ displayName: 'Dilnoza R', color: '#3ddc97' }} />)
    expect(screen.getByRole('img', { name: 'Dilnoza R' })).toHaveTextContent('DR')
  })

  it('AvatarStack collapses the overflow into +N', () => {
    const users = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, displayName: id, color: '#6cb4ff' }))
    render(<AvatarStack users={users} max={3} />)
    expect(screen.getAllByRole('img')).toHaveLength(3)
    expect(screen.getByText('+2')).toBeInTheDocument()
  })
})

describe('Tooltip', () => {
  it('shows on keyboard focus, hides on Escape', async () => {
    render(
      <Tooltip content="Hint">
        <button type="button">Target</button>
      </Tooltip>,
    )
    await userEvent.tab()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Hint')
    expect(screen.getByRole('button', { name: 'Target' })).toHaveAccessibleDescription('Hint')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('opens after a hover delay for a mouse and on tap for touch', () => {
    vi.useFakeTimers()
    render(
      <Tooltip content="Hint">
        <button type="button">Target</button>
      </Tooltip>,
    )
    const anchor = screen.getByRole('button').parentElement as HTMLElement
    fireEvent.pointerEnter(anchor, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(200))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(150))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.pointerLeave(anchor, { pointerType: 'mouse' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.pointerDown(anchor, { pointerType: 'touch' })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.pointerDown(document.body, { pointerType: 'touch' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})

describe('Panel', () => {
  it('renders a titled region with actions', () => {
    render(
      <Panel title="Images" actions={<button type="button">x</button>}>
        body
      </Panel>,
    )
    expect(screen.getByRole('heading', { name: 'Images' })).toBeInTheDocument()
    expect(screen.getByText('body')).toBeInTheDocument()
  })
})
