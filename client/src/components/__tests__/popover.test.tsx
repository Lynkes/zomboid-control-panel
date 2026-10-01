import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as React from 'react'
import { render, screen } from '@testing-library/react'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'

// 2026-09 community report (World Map > Custom item drop: the item picker ran
// off the bottom of the window and its list couldn't be reached). The picker
// was portaled INTO its Dialog and positioned by hand, so the dialog's
// transformed scroll box clipped it and a fixed 200px floor / 60vh inner cap
// ignored the room actually left. ui/popover.tsx is the shared fix: portal
// to <body>, let Radix's popper flip/shift it, and bound it to the room
// Radix reports. jsdom does no layout, so these tests pin the wiring that
// produces that behavior (where it renders, what it's told, which classes
// bound it, and that Tailwind compiles them); the rendered result is checked
// in a real browser separately.

// Capture exactly what PopoverContent hands Radix, while still rendering the
// real primitive so the portal/popper assertions below are about the real
// thing.
const captured = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }))
vi.mock('@radix-ui/react-popover', async () => {
  const actual = await vi.importActual<typeof import('@radix-ui/react-popover')>('@radix-ui/react-popover')
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  const Content = ReactActual.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
    captured.props = props
    return ReactActual.createElement(actual.Content, { ...props, ref })
  })
  return { ...actual, Content }
})

beforeEach(() => {
  captured.props = null
})

function renderOpen(contentProps: React.ComponentProps<typeof PopoverContent> = {}) {
  render(
    // A transformed, clipping ancestor -- the shape of DialogContent that
    // used to cut the picker off.
    <div data-testid="clip" className="overflow-y-auto" style={{ transform: 'translate(-50%, -50%)', maxHeight: 200 }}>
      <Popover open modal>
        <PopoverAnchor asChild>
          <button type="button">anchor</button>
        </PopoverAnchor>
        <PopoverContent aria-label="Picker" {...contentProps}>
          <p>body</p>
        </PopoverContent>
      </Popover>
    </div>,
  )
  return screen.getByRole('dialog', { name: 'Picker' })
}

describe('PopoverContent', () => {
  it('portals to <body> in a fixed-position popper wrapper, outside any clipping or transformed ancestor', () => {
    const content = renderOpen()
    expect(screen.getByTestId('clip').contains(content)).toBe(false)

    const wrapper = content.parentElement!
    expect(wrapper).toHaveAttribute('data-radix-popper-content-wrapper')
    expect(wrapper.parentElement).toBe(document.body)
    // Radix positions with floating-ui's `fixed` strategy: coordinates are
    // the real viewport's, not a dialog's containing block.
    expect(wrapper.style.position).toBe('fixed')
  })

  it('always asks Radix to avoid collisions, with 8px padding, 4px off the anchor, start-aligned', () => {
    // A caller can't switch collision avoidance off (it isn't in the prop
    // type); even a forced `false` is overridden.
    renderOpen({ avoidCollisions: false } as unknown as React.ComponentProps<typeof PopoverContent>)
    expect(captured.props).toMatchObject({
      avoidCollisions: true,
      collisionPadding: 8,
      sideOffset: 4,
      align: 'start',
    })
  })

  it('is bounded to the room Radix reports on the chosen side, and scrolls by default', () => {
    const content = renderOpen()
    expect(content.className).toContain('max-h-[var(--radix-popover-content-available-height)]')
    expect(content.className).toContain('max-w-[var(--radix-popover-content-available-width)]')
    expect(content.className).toContain('overflow-y-auto')
    // The variables the classes read are really wired on this element (Radix
    // maps them onto the popper's measurements), so the bound isn't reading
    // an undefined property.
    expect(content.style.getPropertyValue('--radix-popover-content-available-height'))
      .toBe('var(--radix-popper-available-height)')
    expect(content.style.getPropertyValue('--radix-popover-content-available-width'))
      .toBe('var(--radix-popper-available-width)')
    expect(content).toHaveAttribute('data-side', 'bottom')
  })

  it("lets a consumer's own height and overflow replace the defaults while the viewport bound stays", () => {
    const content = renderOpen({ className: 'flex h-[34rem] flex-col overflow-hidden' })
    expect(content.className).toContain('h-[34rem]')
    expect(content.className).toContain('overflow-hidden')
    expect(content.className).not.toContain('overflow-y-auto')
    expect(content.className).toContain('max-h-[var(--radix-popover-content-available-height)]')
  })

  it('compiles its bound classes to real CSS', async () => {
    const content = renderOpen()
    const { css } = await postcss([
      tailwindcss({ content: [{ raw: content.className }], corePlugins: { preflight: false } }),
    ]).process('@tailwind utilities;', { from: undefined })
    const compact = css.replace(/\s+/g, ' ')
    expect(compact).toMatch(/max-height: var\(--radix-popover-content-available-height\)/)
    expect(compact).toMatch(/max-width: var\(--radix-popover-content-available-width\)/)
  })
})
