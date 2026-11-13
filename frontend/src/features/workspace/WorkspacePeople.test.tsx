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

const person = (id: string, displayName: string, color = '#3ddc97') => ({
  id,
  displayName,
  color,
  avatarUrl: null,
})
const you = person('me', 'Me')
const alice = person('u1', 'Alice')
const bob = person('u2', 'Bob', '#ffb84d')

function online(peers: Array<ReturnType<typeof person>>) {
  vi.mocked(useRealtime).mockReturnValue({ snapshot: { you: 'me', peers } } as never)
}

function setup(canFollow = true) {
  const onSelectOnline = vi.fn()
  const onFollow = vi.fn()
  render(
    <WorkspacePeople
      followingId={null}
      canFollow={canFollow}
      onSelectOnline={onSelectOnline}
      onFollow={onFollow}
    />,
  )
  return { onSelectOnline, onFollow }
}

describe('WorkspacePeople', () => {
  beforeEach(() => online([]))

  it('shows nothing when nobody else is in the project', () => {
    online([you])
    setup()
    expect(screen.queryByTestId('people-list')).toBeNull()
  })

  it('lists only the colleagues who are online, never yourself', () => {
    online([you, alice, bob])
    setup()
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(names).toHaveLength(2)
    expect(screen.getByRole('img', { name: 'Alice' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Bob' })).toBeInTheDocument()
    expect(document.querySelector('.rt-online-dot')).toBeNull()
  })

  it('a click on a colleague goes to them', async () => {
    online([you, bob])
    const { onSelectOnline } = setup()
    await userEvent.click(screen.getByRole('button'))
    expect(onSelectOnline).toHaveBeenCalledWith('u2')
  })

  it('a double click starts following them', async () => {
    online([you, bob])
    const { onFollow, onSelectOnline } = setup()
    await userEvent.dblClick(screen.getByRole('button'))
    expect(onFollow).toHaveBeenCalledTimes(1)
    expect(onFollow).toHaveBeenCalledWith('u2')
    // The first click of the pair still went to the colleague's cell.
    expect(onSelectOnline).toHaveBeenCalledTimes(1)
  })

  it('without the follow permission a double click only goes to the cell', async () => {
    online([you, bob])
    const { onFollow, onSelectOnline } = setup(false)
    await userEvent.dblClick(screen.getByRole('button'))
    expect(onFollow).not.toHaveBeenCalled()
    expect(onSelectOnline).toHaveBeenCalledTimes(2)
  })

  it('shows the name in a tooltip on hover', async () => {
    online([you, alice])
    setup()
    await userEvent.hover(screen.getByRole('button'))
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
      online([you, alice, bob])
      const { onSelectOnline } = setup()
      const [first] = screen.getAllByRole('button')
      await userEvent.click(first as HTMLElement)
      expect(onSelectOnline).not.toHaveBeenCalled()
      expect(screen.getByTestId('people-list')).toHaveAttribute('data-open')
      await userEvent.click(first as HTMLElement)
      expect(onSelectOnline).toHaveBeenCalledWith('u1')
    })

    it('a tap outside closes the spread stack', async () => {
      online([you, alice, bob])
      setup()
      await userEvent.click(screen.getAllByRole('button')[0] as HTMLElement)
      await userEvent.click(document.body)
      expect(screen.getByTestId('people-list')).not.toHaveAttribute('data-open')
    })
  })
})
