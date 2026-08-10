import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ServerStatusBadge } from '../ServerStatusBadge'

const host = { status: 'running', label: 'Container' }
const server = { status: 'disconnected', label: 'RCON' }
const bridge = { status: 'offline', label: 'PanelBridge' }

describe('ServerStatusBadge', () => {
  it('renders each provided signal as its own status indicator', () => {
    render(<ServerStatusBadge host={host} server={server} bridge={bridge} />)
    expect(screen.getByText('Container: Running')).toBeInTheDocument()
    expect(screen.getByText('RCON: Disconnected')).toBeInTheDocument()
    expect(screen.getByText('PanelBridge: Offline')).toBeInTheDocument()
  })

  it('does not collapse container-running-but-rcon-down into one flag', () => {
    render(<ServerStatusBadge host={{ status: 'running', label: 'Container' }} server={server} />)
    expect(screen.getByText('Container: Running')).toBeInTheDocument()
    expect(screen.getByText('RCON: Disconnected')).toBeInTheDocument()
  })

  it('renders a compact dot row with short-form summary text', () => {
    render(<ServerStatusBadge host={host} server={server} compact />)
    expect(screen.getByText('Container Up')).toBeInTheDocument()
    expect(screen.getByText('RCON Down')).toBeInTheDocument()
  })

  it('keeps healthy state neutral and colors degraded state', () => {
    render(<ServerStatusBadge host={host} server={server} compact />)
    expect(screen.getByText('Container Up')).toHaveClass('text-foreground')
    expect(screen.getByText('RCON Down')).toHaveClass('text-destructive')
  })

  it('omits signals that were not passed in', () => {
    render(<ServerStatusBadge host={host} />)
    expect(screen.getByText('Container: Running')).toBeInTheDocument()
    expect(screen.queryByText(/RCON/)).not.toBeInTheDocument()
  })

  it('shows a dash placeholder when no signal is known', () => {
    render(<ServerStatusBadge />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it.each([
    ['unknown', 'Host'],
    ['not-applicable', 'Host'],
    ['not-installed', 'PanelBridge'],
  ])('renders without crashing for status="%s"', (status, label) => {
    const { container } = render(<ServerStatusBadge host={{ status, label }} />)
    expect(container.firstChild).toBeInTheDocument()
  })
})
