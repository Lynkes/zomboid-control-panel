import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Setup from '../Setup'
import enSetup from '../../locales/en/setup.json'

// UX restructure (slice D, Setup P2): the "Create account" button stayed grey
// with nothing saying what it was waiting for. The disabled button now
// explains it (the first unmet check, in the words handleSubmit would use),
// and the fake 3-step progress strip became a plain "What happens next" list.

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ setup: vi.fn(), retryAuthCheck: vi.fn() }),
}))

afterEach(() => {
  cleanup()
})

function renderSetup() {
  return render(
    <TooltipProvider>
      <Setup />
    </TooltipProvider>,
  )
}

// The focusable wrapper DisabledReason puts around the disabled button.
const reasonTrigger = () => screen.getByRole('button', { name: enSetup.submit }).parentElement as HTMLElement

describe('Setup.tsx: the disabled submit says what is missing', () => {
  it('asks for the setup token first', async () => {
    renderSetup()
    expect(screen.getByRole('button', { name: enSetup.submit })).toBeDisabled()
    fireEvent.focus(reasonTrigger())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(enSetup.errors.setupTokenRequired)
  })

  it('then names the next unmet check: passwords that do not match', async () => {
    renderSetup()
    fireEvent.change(screen.getByLabelText(enSetup.setupToken.label), { target: { value: 'a-real-token' } })
    fireEvent.change(screen.getByLabelText(enSetup.password.label), { target: { value: 'correct-horse' } })
    fireEvent.change(screen.getByLabelText(enSetup.confirmPassword.label), { target: { value: 'correct-horsf' } })
    fireEvent.focus(reasonTrigger())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(enSetup.errors.passwordsDontMatch)
  })

  it('has no reason wrapper once the form is complete', () => {
    renderSetup()
    fireEvent.change(screen.getByLabelText(enSetup.setupToken.label), { target: { value: 'a-real-token' } })
    fireEvent.change(screen.getByLabelText(enSetup.password.label), { target: { value: 'correct-horse' } })
    fireEvent.change(screen.getByLabelText(enSetup.confirmPassword.label), { target: { value: 'correct-horse' } })
    const submit = screen.getByRole('button', { name: enSetup.submit })
    expect(submit).not.toBeDisabled()
    expect(submit.parentElement?.getAttribute('tabindex')).toBeNull()
  })

  it('shows "What happens next" as a plain list, not a progress strip', () => {
    renderSetup()
    expect(screen.getByRole('heading', { name: enSetup.afterThisStep.nextHeading })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: enSetup.stepsAriaLabel })).not.toBeInTheDocument()
    expect(screen.getByText(enSetup.afterThisStep.step1Title).closest('li')).not.toBeNull()
  })
})
