import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConnectionStatus } from '../ConnectionStatus'
import { ConnectionStatusContext, type ConnectionStatus as Status } from '@/contexts/SocketContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import en from '@/locales/en/connectionStatus.json'

function renderWithStatus(status: Status, props: { showLabel?: boolean } = {}) {
  return render(
    <ConnectionStatusContext.Provider value={status}>
      <TooltipProvider>
        <ConnectionStatus {...props} />
      </TooltipProvider>
    </ConnectionStatusContext.Provider>
  )
}

const connected: Status = { connected: true, reconnecting: false, reconnectAttempt: 0, error: null }
const reconnecting: Status = { connected: false, reconnecting: true, reconnectAttempt: 3, error: null }
const disconnected: Status = { connected: false, reconnecting: false, reconnectAttempt: 0, error: null }
const disconnectedWithError: Status = {
  connected: false,
  reconnecting: false,
  reconnectAttempt: 0,
  error: 'socket hang up',
}

describe('ConnectionStatus', () => {
  it('renders nothing when fully connected -- a stale "connected" badge would be noise, not signal', () => {
    const { container } = renderWithStatus(connected)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the real reconnect attempt count while reconnecting, not a generic spinner', () => {
    renderWithStatus(reconnecting, { showLabel: true })
    expect(screen.getByText(en.reconnecting.label)).toBeInTheDocument()
  })

  it('reports disconnected with the real backend error message in the tooltip, not a canned string', async () => {
    renderWithStatus(disconnectedWithError, { showLabel: true })
    expect(screen.getByText(en.disconnected.label)).toBeInTheDocument()

    fireEvent.focus(screen.getByText(en.disconnected.label).closest('div')!)
    expect(await screen.findByText('socket hang up')).toBeInTheDocument()
  })

  it('falls back to a generic disconnected description only when no error is known', async () => {
    renderWithStatus(disconnected, { showLabel: true })
    fireEvent.focus(screen.getByText(en.disconnected.label).closest('div')!)
    expect(await screen.findByText(en.disconnected.description)).toBeInTheDocument()
  })

  it('keeps the label visually hidden (not absent) when showLabel is false, for screen readers', () => {
    renderWithStatus(disconnected)
    expect(screen.queryByText(en.disconnected.label, { selector: 'span:not(.sr-only)' })).not.toBeInTheDocument()
    expect(screen.getByText(en.disconnected.label, { selector: '.sr-only' })).toBeInTheDocument()
  })
})
