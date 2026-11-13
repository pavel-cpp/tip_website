import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function setup(contributors = [you, alice, bob], canFollow = true) {
  const onSelectOnline = vi.fn()
  const onFollow = vi.fn()
  const onSelectLastRow = vi.fn()
  render(
    <WorkspacePeople
      contributors={contributors}
      followingId={null}
      canFollow={canFollow}
      onSelectOnline={onSelectOnline}
      onFollow={onFollow}
      onSelectLastRow={onSelectLastRow}
    />,
  )
  return { onSelectOnline, onFollow, onSelectLastRow }
}

describe('WorkspacePeople', () => {
  beforeEach(() => online([]))

  it('lists everyone who worked in the project except yourself, none marked online when nobody is', () => {
    setup()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(document.querySelector('[data-online]')).toBeNull()
  })

  it('lists colleagues who are online first and marks them, with no dot on the avatars', () => {
    online([you, { ...bob }])
    setup()
    const buttons = screen.getAllByRole('button')
    expect(buttons[0]).toHaveAttribute('data-online')
    expect(document.querySelector('.rt-online-dot')).toBeNull()
    expect(buttons[0]?.querySelector('[aria-label="Bob"]')).not.toBeNull()
    expect(buttons[1]).not.toHaveAttribute('data-online')
  })

  it('a click on an online colleague goes to them, on an away one it opens their last row', async () => {
    online([you, bob])
    const { onSelectOnline, onSelectLastRow } = setup()
    const [first, second] = screen.getAllByRole('button')
    await userEvent.click(first as HTMLElement)
    expect(onSelectOnline).toHaveBeenCalledWith('u2')
    await userEvent.click(second as HTMLElement)
    expect(onSelectLastRow).toHaveBeenCalledWith('r1')
  })

  it('a double click on an online colleague starts following them', async () => {
    online([you, bob])
    const { onFollow, onSelectOnline } = setup()
    await userEvent.dblClick(screen.getAllByRole('button')[0] as HTMLElement)
    expect(onFollow).toHaveBeenCalledTimes(1)
    expect(onFollow).toHaveBeenCalledWith('u2')
    // The first click of the pair still went to the colleague's cell.
    expect(onSelectOnline).toHaveBeenCalledTimes(1)
  })

  it('without the follow permission a double click only goes to the cell', async () => {
    online([you, bob])
    const { onFollow, onSelectOnline } = setup([you, alice, bob], false)
    await userEvent.dblClick(screen.getAllByRole('button')[0] as HTMLElement)
    expect(onFollow).not.toHaveBeenCalled()
    expect(onSelectOnline).toHaveBeenCalledTimes(2)
  })

  it('a double click on an away colleague does not follow, it opens their last row', async () => {
    const { onFollow, onSelectLastRow } = setup()
    await userEvent.dblClick(screen.getAllByRole('button')[0] as HTMLElement)
    expect(onFollow).not.toHaveBeenCalled()
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

  describe('on a touch screen', () => {
    beforeEach(() => {
      vi.stubGlobal('matchMedia', (q: string) => ({
        matches: q === '(hover: none)',
        addEventListener() {},
        removeEventListener() {},
      }))
    })
    afterEach(() => vi.unstubAllGlobals())

    it('the first tap spreads the stack and only the next tap picks a colleague', async () => {
      online([you, bob])
      const { onSelectOnline } = setup()
      const [first] = screen.getAllByRole('button')
      await userEvent.click(first as HTMLElement)
      expect(onSelectOnline).not.toHaveBeenCalled()
      expect(screen.getByTestId('people-list')).toHaveAttribute('data-open')
      await userEvent.click(first as HTMLElement)
      expect(onSelectOnline).toHaveBeenCalledWith('u2')
    })

    it('a tap outside closes the spread stack', async () => {
      online([you, bob])
      setup()
      await userEvent.click(screen.getAllByRole('button')[0] as HTMLElement)
      await userEvent.click(document.body)
      expect(screen.getByTestId('people-list')).not.toHaveAttribute('data-open')
    })
  })
})
