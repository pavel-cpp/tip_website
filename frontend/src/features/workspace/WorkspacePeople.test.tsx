import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRealtime } from '../realtime/RealtimeProvider'
import { WorkspacePeople } from './WorkspacePeople'

vi.mock('../realtime/RealtimeProvider', () => ({ useRealtime: vi.fn() }))
vi.mock('../../auth/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { displayName: string } }) => (
    <span role="img" aria-label={user.displayName} />
  ),
}))

const alice = { id: 'u1', displayName: 'Alice', color: '#3ddc97', avatarUrl: null, lastRowId: 'r1' }
const bob = { id: 'u2', displayName: 'Bob', color: '#ffb84d', avatarUrl: null, lastRowId: null }
const you = { id: 'me', displayName: 'Me', color: '#6ea8fe', avatarUrl: null, lastRowId: 'r9' }

function online(peers: Array<{ id: string; displayName: string; color: string; avatarUrl: string | null }>) {
  vi.mocked(useRealtime).mockReturnValue({ snapshot: { you: 'me', peers } } as never)
}

function setup(contributors = [you, alice, bob]) {
  const onSelectOnline = vi.fn()
  const onSelectLastRow = vi.fn()
  render(
    <WorkspacePeople
      contributors={contributors}
      watchedId={null}
      onSelectOnline={onSelectOnline}
      onSelectLastRow={onSelectLastRow}
    />,
  )
  return { onSelectOnline, onSelectLastRow }
}

describe('WorkspacePeople', () => {
  beforeEach(() => online([]))

  it('lists everyone who worked in the project except yourself, with no dot when nobody is online', () => {
    setup()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(document.querySelector('.rt-online-dot')).toBeNull()
  })

  it('puts a green dot on colleagues who are online and lists them first', () => {
    online([you, { ...bob }])
    setup()
    const buttons = screen.getAllByRole('button')
    expect(buttons[0]?.querySelector('.rt-online-dot')).not.toBeNull()
    expect(buttons[0]?.querySelector('[aria-label="Bob"]')).not.toBeNull()
    expect(buttons[1]?.querySelector('.rt-online-dot')).toBeNull()
  })

  it('a click on an online colleague follows them, on an away one it opens their last row', async () => {
    online([you, bob])
    const { onSelectOnline, onSelectLastRow } = setup()
    const [first, second] = screen.getAllByRole('button')
    await userEvent.click(first as HTMLElement)
    expect(onSelectOnline).toHaveBeenCalledWith('u2')
    await userEvent.click(second as HTMLElement)
    expect(onSelectLastRow).toHaveBeenCalledWith('r1')
  })

  it('does nothing for someone who has not edited anything', async () => {
    const { onSelectLastRow, onSelectOnline } = setup([bob])
    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(btn)
    expect(onSelectLastRow).not.toHaveBeenCalled()
    expect(onSelectOnline).not.toHaveBeenCalled()
  })

  it('shows the name in a tooltip on hover', async () => {
    setup()
    await userEvent.hover(screen.getAllByRole('button')[0] as HTMLElement)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Alice')
  })
})
