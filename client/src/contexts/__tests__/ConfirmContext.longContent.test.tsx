import { afterEach, describe, expect, it } from 'vitest'
import { useEffect } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { ConfirmProvider, useConfirm, type ConfirmOptions } from '../ConfirmContext'

// 2026-09 dialog sweep (after the Templates preview community report): the
// Files page fills the shared confirm with root-relative paths, and a
// permanent delete adds several paragraphs plus a typed confirmation.
//  - Items were `truncate`d. In the dialog's auto-width grid that never
//    truncated: a long path widened the dialog past a phone screen and the
//    confirm button went off to the side. Capped, it would hide exactly the
//    part that tells two paths in one folder apart. They wrap now.
//  - On a landscape phone the dialog scrolled as a whole and autofocus on
//    the typed field scrolled the title and "can't be undone" away, with the
//    item list a second scroller nested inside. The description and items
//    now scroll in one AlertDialogBody; title, typed field and buttons stay.
// jsdom does no layout; this pins the structure (measured in Chromium).

function Ask({ options }: { options: ConfirmOptions }) {
  const confirm = useConfirm()
  useEffect(() => { void confirm(options) }, [confirm, options])
  return null
}

function open(options: ConfirmOptions) {
  render(<ConfirmProvider><Ask options={options} /></ConfirmProvider>)
  return screen.findByRole('alertdialog')
}

afterEach(cleanup)

const PATHS = [
  'media/lua/server/Items/SAKUPrecisionSVE_Distributions.lua',
  'media/lua/server/Items/SAKUPrecisionSVE_ProceduralDistributions.lua',
]

describe('ConfirmProvider with long content', () => {
  it('wraps each item in full instead of truncating it', async () => {
    const dialog = await open({ title: 'Delete 2 items?', description: 'Moves them to the trash.', items: PATHS })
    for (const path of PATHS) {
      const li = within(dialog).getByText(path)
      expect(li.className).not.toContain('truncate')
      expect(li.className).toContain('[overflow-wrap:anywhere]')
    }
  })

  it('scrolls the description and items in one body, keeping the title, typed field and buttons outside it', async () => {
    const dialog = await open({
      title: 'Delete permanently?',
      description: "This can't be undone.\n\nThe server has no trash folder.",
      items: PATHS,
      requireTypedConfirmation: { value: '2', label: 'Type 2 to confirm' },
      confirmLabel: 'Delete permanently',
    })
    const body = dialog.querySelector<HTMLElement>('[data-dialog-body]')
    expect(body).not.toBeNull()
    expect(body!.parentElement).toBe(dialog)
    expect(body!.contains(within(dialog).getByText(/can't be undone/))).toBe(true)
    const list = within(body!).getByRole('list')
    // One scroller: the list no longer has its own cap inside the body.
    expect(list.className).not.toMatch(/max-h-|overflow-y-auto/)

    const outside = [
      within(dialog).getByRole('heading', { name: 'Delete permanently?' }),
      within(dialog).getByLabelText('Type 2 to confirm'),
      within(dialog).getByRole('button', { name: 'Cancel' }),
      within(dialog).getByRole('button', { name: 'Delete permanently' }),
    ]
    for (const el of outside) expect(body!.contains(el)).toBe(false)
    // The field autofocus lands on is outside the scroller, so focusing it
    // can't scroll the description away.
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Type 2 to confirm'))
  })

  it('keeps the compact header layout for a confirm without items', async () => {
    const dialog = await open({
      title: 'Kill KNOXCOUNTYWASTELANDMEGAWARLORD42?',
      description: 'Their character dies.',
      requireTypedConfirmation: { value: 'KNOXCOUNTYWASTELANDMEGAWARLORD42', label: 'Type the name to confirm' },
    })
    expect(dialog.querySelector('[data-dialog-body]')).toBeNull()
    const title = within(dialog).getByRole('heading')
    expect(title.parentElement!.contains(within(dialog).getByText('Their character dies.'))).toBe(true)
    expect(title.parentElement!.contains(within(dialog).getByLabelText('Type the name to confirm'))).toBe(true)
    // The unbroken name in the title wraps instead of widening the dialog.
    expect(title.className).toContain('[overflow-wrap:anywhere]')
  })
})
