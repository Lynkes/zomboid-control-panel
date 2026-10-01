import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  TemplateApplyFooter, TemplateApplyOutcome, TemplateApplyScope, TemplateApplyWarning,
} from '../TemplateApplyPanel'

const scopeProps = {
  scopeIni: true,
  scopeSandbox: true,
  onScopeIniChange: vi.fn(),
  onScopeSandboxChange: vi.fn(),
  canManage: true,
  applied: false,
}

const footerProps = {
  scopeIni: true,
  scopeSandbox: true,
  applying: false,
  applied: false,
  canManage: true,
  canApply: true,
  onApply: vi.fn(),
  onClose: vi.fn(),
}

describe('TemplateApplyFooter', () => {
  it.each([true, null])('disables apply when running state is %s', (running) => {
    render(<TemplateApplyFooter {...footerProps} running={running} />)

    const applyButton = screen.getByRole('button', { name: 'Apply Template' })
    expect(applyButton).toBeDisabled()
    fireEvent.click(applyButton)
    expect(footerProps.onApply).not.toHaveBeenCalled()
  })

  it('enables apply only when the server is verified stopped', () => {
    render(<TemplateApplyFooter {...footerProps} running={false} />)

    expect(screen.getByRole('button', { name: 'Apply Template' })).toBeEnabled()
  })

  it('disables apply when neither scope is selected', () => {
    render(<TemplateApplyFooter {...footerProps} running={false} scopeIni={false} scopeSandbox={false} />)

    expect(screen.getByRole('button', { name: 'Apply Template' })).toBeDisabled()
  })

  it('goes away once the template has been applied', () => {
    const { container } = render(<TemplateApplyFooter {...footerProps} running={false} applied />)

    expect(container).toBeEmptyDOMElement()
  })
})

describe('TemplateApplyWarning', () => {
  it.each([
    [true, 'Server is running'],
    [null, 'Server state unavailable'],
  ] as const)('explains why Apply is disabled when running is %s', (running, title) => {
    render(<TemplateApplyWarning running={running} canManage applied={false} />)
    expect(screen.getByText(title)).toBeInTheDocument()
  })

  it('says nothing once the server is confirmed stopped, or after applying', () => {
    const { container } = render(
      <>
        <TemplateApplyWarning running={false} canManage applied={false} />
        <TemplateApplyWarning running applied canManage />
      </>,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('TemplateApplyScope', () => {
  it('offers both scopes', () => {
    render(<TemplateApplyScope {...scopeProps} />)
    expect(screen.getByRole('checkbox', { name: 'Apply sandbox changes' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Apply server.ini changes' })).toBeChecked()
  })
})

describe('TemplateApplyOutcome', () => {
  it('shows the failure of the last Apply', () => {
    render(<TemplateApplyOutcome applyError="Disk full" applyResult={null} canManage />)
    expect(screen.getByText('Apply Failed')).toBeInTheDocument()
    expect(screen.getByText('Disk full')).toBeInTheDocument()
  })

  it('shows nothing before an Apply', () => {
    const { container } = render(<TemplateApplyOutcome applyError={null} applyResult={null} canManage />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('viewers', () => {
  it('get no mutation controls', () => {
    const { container } = render(
      <>
        <TemplateApplyWarning running canManage={false} applied={false} />
        <TemplateApplyScope {...scopeProps} canManage={false} />
        <TemplateApplyOutcome applyError="x" applyResult={null} canManage={false} />
        <TemplateApplyFooter {...footerProps} running={false} canManage={false} />
      </>,
    )

    expect(container).toBeEmptyDOMElement()
  })
})
