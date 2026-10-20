import { useTranslation } from 'react-i18next'
import { Download, FolderOpen, Globe, type LucideIcon } from 'lucide-react'

// The one way to say "add a server": the same three choices, words and
// destinations on the Dashboard, the Servers header menu and empty state, and
// the Add a Server page (DESIGN.md naming rule). The list itself is
// components/AddServerChoices.tsx.

export type AddServerChoice = 'fresh' | 'existing' | 'remote'

export const ADD_SERVER_CHOICES: readonly AddServerChoice[] = ['fresh', 'existing', 'remote']

/**
 * Where each choice goes when the caller has no handler of its own. The
 * Servers page reads `?add=existing|remote` and opens its dialog; the Add a
 * Server page reads `?mode=fresh|existing`.
 */
export const ADD_SERVER_LINKS: Record<AddServerChoice, string> = {
  fresh: '/server-setup?mode=fresh',
  existing: '/servers?add=existing',
  remote: '/servers?add=remote',
}

export const ADD_SERVER_ICONS: Record<AddServerChoice, LucideIcon> = {
  fresh: Download,
  existing: FolderOpen,
  remote: Globe,
}

export interface AddServerChoiceMeta {
  id: AddServerChoice
  label: string
  description: string
  icon: LucideIcon
  to: string
}

/** Labels, descriptions, icons and default links, for menus that list the choices. */
export function useAddServerChoices(): AddServerChoiceMeta[] {
  const { t } = useTranslation('servers')
  return ADD_SERVER_CHOICES.map((id) => ({
    id,
    label: t(`addServer.${id}.label`),
    description: t(`addServer.${id}.description`),
    icon: ADD_SERVER_ICONS[id],
    to: ADD_SERVER_LINKS[id],
  }))
}
