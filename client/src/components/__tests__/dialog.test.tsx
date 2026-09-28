import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import {
  Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/dialog'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle,
  AlertDialogDescription, AlertDialogCancel, AlertDialogAction,
} from '../ui/alert-dialog'

// 2026-09 community report (Edit Server dialog cut off, "had to change the
// page zoom to see all of it"): the viewport bound used to be a per-call-site
// opt-in (max-h-[85vh] overflow-y-auto), so every dialog that didn't carry it
// could run its own buttons off a short or zoomed-in window. It now lives in
// the shared primitives. jsdom does no layout, so these tests pin the classes
// that produce the behavior and check that Tailwind really compiles them; the
// rendered result was measured separately in headless Chromium.

const BOUND = 'max-h-[calc(100dvh-2rem)]'
const HAS_BODY_FLEX = 'has-[>[data-dialog-body]]:flex'
const HAS_BODY_COL = 'has-[>[data-dialog-body]]:flex-col'

function renderDialog(contentClassName?: string, withBody = true) {
  render(
    <Dialog open>
      <DialogContent className={contentClassName}>
        <DialogHeader>
          <DialogTitle>Edit</DialogTitle>
          <DialogDescription>Change things</DialogDescription>
        </DialogHeader>
        {withBody ? <DialogBody>fields</DialogBody> : <div>fields</div>}
        <DialogFooter>
          <button type="button">Save</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  )
  return screen.getByRole('dialog')
}

describe('DialogContent', () => {
  it('is bounded to the viewport and scrolls whatever does not fit, keeping its grid layout by default', () => {
    const dialog = renderDialog(undefined, false)
    expect(dialog.className).toContain(BOUND)
    expect(dialog.className).toContain('overflow-y-auto')
    // No DialogBody: the :has() switch below matches nothing, so the grid
    // every existing dialog was built against is still what lays it out.
    expect(dialog.className).toMatch(/(^|\s)grid(\s|$)/)
  })

  it("lets a call site's own height cap replace the default instead of stacking with it", () => {
    const capped = renderDialog('max-h-[85vh] sm:max-h-[80vh]')
    expect(capped.className).not.toContain(BOUND)
    expect(capped.className).toContain('max-h-[85vh]')
    expect(capped.className).toContain('sm:max-h-[80vh]')
  })

  it('lets a dialog opt out of the scroll container (a non-portaled popup that must spill past the box)', () => {
    const dialog = renderDialog('overflow-visible')
    expect(dialog.className).toContain('overflow-visible')
    expect(dialog.className).not.toContain('overflow-y-auto')
    expect(dialog.className).toContain(BOUND)
  })
})

describe('DialogBody', () => {
  it('renders as a direct child of the dialog, marked for the :has() flex switch, as the one scrolling region', () => {
    const dialog = renderDialog()
    expect(dialog.className).toContain(HAS_BODY_FLEX)
    expect(dialog.className).toContain(HAS_BODY_COL)

    const body = dialog.querySelector<HTMLElement>('[data-dialog-body]')
    expect(body).not.toBeNull()
    expect(body!.parentElement).toBe(dialog)
    expect(body!.textContent).toBe('fields')
    // min-h-0 lets it shrink below its content inside the flex column;
    // overflow-y-auto makes the rest scroll.
    expect(body!.className).toContain('min-h-0')
    expect(body!.className).toContain('overflow-y-auto')
    // Ruled off from the pinned header and footer, so scrolled-up helper
    // text doesn't read as part of the dialog description.
    expect(body!.className).toContain('border-y')
    expect(body!.className).toContain('border-border/40')

    // Header and footer are its siblings, not its children, so they never
    // scroll away with it.
    const save = screen.getByRole('button', { name: 'Save' })
    expect(dialog.contains(save)).toBe(true)
    expect(body!.contains(save)).toBe(false)
    expect(body!.contains(screen.getByText('Edit'))).toBe(false)
  })
})

describe('AlertDialogContent', () => {
  it('carries the same viewport bound and scroll container', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>Deletes it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    )
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.className).toContain(BOUND)
    expect(dialog.className).toContain('overflow-y-auto')
  })
})

describe('Tailwind output for the new class strings', () => {
  // Compiles the classes the components actually render, not a copy of
  // them, so a typo in a variant or arbitrary value fails here instead of
  // silently shipping no CSS (the way justify-[safe_center] once compiled to
  // nothing -- see index.css).
  it('emits the dvh bound, the :has() flex switch and the DialogBody scroll and rule classes', async () => {
    const dialog = renderDialog()
    const body = dialog.querySelector<HTMLElement>('[data-dialog-body]')!
    const { css } = await postcss([
      tailwindcss({
        content: [{ raw: `${dialog.className} ${body.className}` }],
        corePlugins: { preflight: false },
      }),
    ]).process('@tailwind utilities;', { from: undefined })
    const compact = css.replace(/\s+/g, ' ')

    expect(compact).toMatch(/max-height: calc\(100dvh - 2rem\)/)
    expect(compact).toMatch(/:has\(>\[data-dialog-body\]\) \{ display: flex/)
    expect(compact).toMatch(/:has\(>\[data-dialog-body\]\) \{ flex-direction: column/)
    expect(compact).toMatch(/\.min-h-0 \{ min-height: 0px/)
    expect(compact).toMatch(/\.overflow-y-auto \{ overflow-y: auto/)
    expect(compact).toMatch(/\.border-y \{ border-top-width: 1px; border-bottom-width: 1px/)
  })
})
