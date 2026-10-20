import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AddServerChoices, ADD_SERVER_LINKS } from '../AddServerChoices'

// One way to say "add a server" (UX plan §2.2): the Dashboard, the Servers
// header and empty state and the Add a Server page all list the same three
// choices with the same words.

afterEach(() => cleanup())

function renderChoices(props: Parameters<typeof AddServerChoices>[0] = {}) {
  return render(
    <MemoryRouter>
      <AddServerChoices {...props} />
    </MemoryRouter>,
  )
}

describe('AddServerChoices', () => {
  it('lists the three standard choices as links to their flows by default', () => {
    renderChoices()
    const list = screen.getByRole('list', { name: 'Ways to add a server' })
    const links = within(list).getAllByRole('link')
    expect(links).toHaveLength(3)
    expect(screen.getByRole('link', { name: /Install a new server/ })).toHaveAttribute('href', ADD_SERVER_LINKS.fresh)
    expect(screen.getByRole('link', { name: /Use existing server files/ })).toHaveAttribute('href', '/servers?add=existing')
    expect(screen.getByRole('link', { name: /Connect a remote server/ })).toHaveAttribute('href', '/servers?add=remote')
  })

  it('a handler turns that choice into a button that calls it instead of navigating', () => {
    const onExisting = vi.fn()
    renderChoices({ onChoose: { existing: onExisting } })
    fireEvent.click(screen.getByRole('button', { name: /Use existing server files/ }))
    expect(onExisting).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: /Install a new server/ })).toBeInTheDocument()
  })

  it('marks the recommended choice', () => {
    renderChoices({ recommended: 'existing' })
    expect(within(screen.getByRole('link', { name: /Use existing server files/ })).getByText('Recommended')).toBeInTheDocument()
    expect(within(screen.getByRole('link', { name: /Install a new server/ })).queryByText('Recommended')).not.toBeInTheDocument()
  })

  it('a disabled choice says why, in the row itself', () => {
    renderChoices({ disabledReasons: { fresh: 'Installing needs the server.install permission.' } })
    const fresh = screen.getByRole('button', { name: /Install a new server/ })
    expect(fresh).toBeDisabled()
    expect(fresh).toHaveTextContent('Installing needs the server.install permission.')
  })

  it('can leave a choice out', () => {
    renderChoices({ hide: ['remote'] })
    expect(screen.queryByText('Connect a remote server')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })
})
