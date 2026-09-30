import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { ScrollArea } from '../ui/scroll-area'

// This guards the fix itself from silently regressing, not a general detector
// for new misuse elsewhere -- jsdom does no real box layout, so it cannot
// measure whether content actually overflows, and asserting otherwise here
// would be a test that can't fail. See conv-hunt-pages (Scheduler, Debug,
// Players, Backups): Radix's ScrollArea Viewport wraps content in an internal
// `minWidth:100%; display:table` div, private markup we can't reach via
// props. Every real ScrollArea in this app is vertical-only (grepped: exactly
// one <ScrollBar>, defaulting to vertical, ever rendered), so Radix's own
// overflowX stays "hidden" regardless -- meaning that table sizing only ever
// lets content grow past the viewport with nowhere to scroll, silently
// clipping instead of wrapping/truncating as authored. This component clamps
// that wrapper to block layout by default; allowHorizontalOverflow opts back
// into Radix's native behavior for a genuine future wide-content case.
const CLAMP_CLASSNAME = '[&_[data-radix-scroll-area-viewport]>div]:!block'

describe('ScrollArea', () => {
  it('clamps the internal Viewport content wrapper to block layout by default', () => {
    const { container } = render(
      <ScrollArea>
        <div>content</div>
      </ScrollArea>,
    )
    expect((container.firstChild as HTMLElement).className).toContain(CLAMP_CLASSNAME)
  })

  it('allowHorizontalOverflow removes the clamp', () => {
    const { container } = render(
      <ScrollArea allowHorizontalOverflow>
        <div>content</div>
      </ScrollArea>,
    )
    expect((container.firstChild as HTMLElement).className).not.toContain(CLAMP_CLASSNAME)
  })
})

// 2026-09 dialog sweep (Players > Import/Export > Saved Exports): a
// ScrollArea bounded only by max-h-* never scrolled -- the Viewport is h-full,
// which can't resolve against a max-height, so it grew to its content and the
// Root clipped it; rows past the cap were unreachable. The Viewport inherits
// the Root's max-height now.
describe('ScrollArea bounded by a max-height', () => {
  it("gives the Viewport the Root's max-height, so it scrolls instead of being clipped", () => {
    const { container } = render(
      <ScrollArea className="max-h-[180px]">
        <div>content</div>
      </ScrollArea>,
    )
    const viewport = container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!
    expect(viewport.className).toContain('max-h-[inherit]')
    expect(viewport.className).toContain('h-full')
  })

  it('compiles max-h-[inherit] to real CSS', async () => {
    const { container } = render(<ScrollArea><div>content</div></ScrollArea>)
    const viewport = container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!
    const { css } = await postcss([
      tailwindcss({ content: [{ raw: viewport.className }], corePlugins: { preflight: false } }),
    ]).process('@tailwind utilities;', { from: undefined })
    expect(css.replace(/\s+/g, ' ')).toMatch(/\{ max-height: inherit/)
  })
})
