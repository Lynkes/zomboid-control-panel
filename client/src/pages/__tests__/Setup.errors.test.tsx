import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import i18n from '@/i18n'
import { ApiError } from '@/lib/api'
import Setup from '../Setup'
import arSetup from '../../locales/ar/setup.json'
import arErrors from '../../locales/ar/errors.json'
import frSetup from '../../locales/fr/setup.json'
import frErrors from '../../locales/fr/errors.json'

// jsdom has no ResizeObserver -- Radix's Checkbox needs one to mount.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const setupFn = vi.fn()
const retryAuthCheck = vi.fn()

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ setup: setupFn, retryAuthCheck }),
}))

const toastMock = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}))

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  void i18n.changeLanguage('en')
})

function submitValidForm(labels: typeof arSetup) {
  render(
    <TooltipProvider>
      <Setup />
    </TooltipProvider>,
  )
  fireEvent.change(screen.getByLabelText(labels.setupToken.label), { target: { value: 'a-real-token' } })
  fireEvent.change(screen.getByLabelText(labels.password.label), { target: { value: 'correct-horse' } })
  fireEvent.change(screen.getByLabelText(labels.confirmPassword.label), { target: { value: 'correct-horse' } })
  fireEvent.click(screen.getByRole('button', { name: labels.submit }))
}

describe('Setup.tsx: a failed account creation is shown in the active language', () => {
  it('translates the coded SETUP_FAILED error setup() throws', async () => {
    void i18n.changeLanguage('ar')
    setupFn.mockRejectedValue(new ApiError("We couldn't create the admin account. Try again.", { code: 'SETUP_FAILED' }))
    submitValidForm(arSetup)
    expect(await screen.findByRole('alert')).toHaveTextContent(arErrors.SETUP_FAILED)
  })

  // The first-run form stayed up, saying "Setup already completed. Use login
  // instead.", while the app (whose needsSetup flag was never re-read) kept
  // showing it: no way to reach the sign-in screen without a reload.
  it('re-checks the panel and tells the user why when an account already exists', async () => {
    void i18n.changeLanguage('fr')
    setupFn.mockRejectedValue(new ApiError('Setup already completed. Use login instead.', { status: 400, code: 'SETUP_ALREADY_COMPLETED' }))
    submitValidForm(frSetup)

    await waitFor(() => expect(retryAuthCheck).toHaveBeenCalledTimes(1))
    expect(toastMock).toHaveBeenCalledWith({ description: frErrors.SETUP_ALREADY_COMPLETED })
    // Not left as a dead-end error on the form.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not re-check for an ordinary failure', async () => {
    void i18n.changeLanguage('ar')
    setupFn.mockRejectedValue(new ApiError('Password is too weak', { status: 400, code: 'WEAK_PASSWORD' }))
    submitValidForm(arSetup)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(retryAuthCheck).not.toHaveBeenCalled()
  })

})
