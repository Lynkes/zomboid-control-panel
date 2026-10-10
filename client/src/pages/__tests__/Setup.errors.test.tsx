import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import i18n from '@/i18n'
import { ApiError } from '@/lib/api'
import Setup from '../Setup'
import arSetup from '../../locales/ar/setup.json'
import arErrors from '../../locales/ar/errors.json'

// jsdom has no ResizeObserver -- Radix's Checkbox needs one to mount.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const setupFn = vi.fn()

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ setup: setupFn }),
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
})
