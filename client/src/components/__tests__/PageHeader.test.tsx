import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PageHeader } from '../PageHeader'

describe('PageHeader', () => {
  it('renders the real title and description passed in', () => {
    render(<PageHeader title="Café Serveur" description="Gérer le serveur" />)
    expect(screen.getByRole('heading', { name: 'Café Serveur' })).toBeInTheDocument()
    expect(screen.getByText('Gérer le serveur')).toBeInTheDocument()
  })

  it('omits the description block entirely when none is given, not an empty paragraph', () => {
    const { container } = render(<PageHeader title="Servers" />)
    expect(container.querySelector('.page-description')).not.toBeInTheDocument()
  })

  it('renders actions content when provided', () => {
    render(<PageHeader title="Servers" actions={<button>Add server</button>} />)
    expect(screen.getByRole('button', { name: 'Add server' })).toBeInTheDocument()
  })

  it('takes its section (the accent) from the route registry, and the registry icon when none is passed', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/players']}>
        <PageHeader title="Players" tone="ops" />
      </MemoryRouter>,
    )
    expect(container.querySelector('.page-header-shell')).toHaveAttribute('data-tone', 'players')
    expect(container.querySelector('.page-title-icon svg')).not.toBeNull()
  })

  it('lets an explicit section win over the registry', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/players']}>
        <PageHeader title="Players" section="world" />
      </MemoryRouter>,
    )
    expect(container.querySelector('.page-header-shell')).toHaveAttribute('data-tone', 'world')
  })

  it('maps the deprecated tone to a section outside a known route', () => {
    const { container, rerender } = render(<PageHeader title="Servers" tone="servers" />)
    expect(container.firstChild).toHaveAttribute('data-tone', 'panel')
    rerender(<PageHeader title="Events" tone="world" />)
    expect(container.firstChild).toHaveAttribute('data-tone', 'world')
    rerender(<PageHeader title="Backups" tone="maintain" />)
    expect(container.firstChild).toHaveAttribute('data-tone', 'server')
  })

  it('defaults to the server section when nothing else says', () => {
    const { container } = render(<PageHeader title="Servers" />)
    expect(container.firstChild).toHaveAttribute('data-tone', 'server')
  })

  it('no longer renders the deprecated eyebrow kicker', () => {
    render(<PageHeader title="Mods" eyebrow="Workshop" />)
    expect(screen.queryByText('Workshop')).not.toBeInTheDocument()
  })

  it('shows live state next to the title (status, or badge as its alias) and one row of facts', () => {
    const { rerender } = render(<PageHeader title="Discord" status={<span>Running</span>} meta={<span>Bot: Spiffo#0001</span>} />)
    const heading = screen.getByRole('heading', { name: 'Discord' })
    expect(heading.parentElement).toHaveTextContent('Running')
    expect(screen.getByText('Bot: Spiffo#0001')).toBeInTheDocument()
    rerender(<PageHeader title="Discord" badge={<span>Stopped</span>} />)
    expect(screen.getByRole('heading', { name: 'Discord' }).parentElement).toHaveTextContent('Stopped')
  })

  it('puts child flows under a breadcrumb back to their parent', () => {
    render(
      <MemoryRouter initialEntries={['/server-setup']}>
        <PageHeader title="Add a server" breadcrumb={[{ label: 'Servers', to: '/servers' }]} />
      </MemoryRouter>,
    )
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('link', { name: 'Servers' })).toHaveAttribute('href', '/servers')
  })
})
