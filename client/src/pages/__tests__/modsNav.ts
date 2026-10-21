import { fireEvent, screen, within } from '@testing-library/react'

// The Mod Manager's section menu (Installed, Active on server, Load order...).
// Below `lg` the same views are also a native <select>, so a view's label is
// on the page twice: tests click the button inside the menu landmark.

/** Waits for the Mod Manager's section menu, then opens the view whose button matches `name`. */
export async function openModsView(name: string | RegExp) {
  const nav = await screen.findByRole('navigation', { name: 'Mod management sections' })
  fireEvent.click(within(nav).getByRole('button', { name: typeof name === 'string' ? new RegExp(`^${name}`, 'i') : name }))
}

/** The section menu's button for a view (to check it is the current one). */
export function modsViewButton(name: string | RegExp) {
  const nav = screen.getByRole('navigation', { name: 'Mod management sections' })
  return within(nav).getByRole('button', { name: typeof name === 'string' ? new RegExp(`^${name}`, 'i') : name })
}
