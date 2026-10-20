import { useContext, type ComponentType } from 'react'
import { UNSAFE_LocationContext } from 'react-router-dom'
import {
  Archive,
  Bug,
  Clock,
  Eraser,
  FileCog,
  FolderTree,
  Gauge,
  Layers,
  LayoutTemplate,
  Map as MapIcon,
  MessageSquare,
  MessagesSquare,
  Package,
  Search,
  Plus,
  Settings,
  Terminal,
  Trophy,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react'

// The one route registry. The sidebar, page headers, the loading skeleton,
// keyboard shortcuts, the command palette, route preloading, App's <Routes>
// and document.title all read their facts from here, so a page has one
// name, one icon and one set of gates everywhere (they used to live in four
// files that drifted apart).
//
// labelKey is the short sidebar label (shell:nav.*). titleKey is the full
// title the page's own header shows, read from the page's own namespace so
// the header, the palette, the loading skeleton and the tab title can't
// disagree. Both are i18next keys with an explicit namespace.

export type PageSection = 'server' | 'players' | 'world' | 'panel'
export type PageSkeletonVariant = 'dashboard' | 'list' | 'form' | 'console' | 'map' | 'default'

export interface RouteDeepLinkItem {
  id: string
  labelKey: string
  /** Hidden from the palette for a role that lacks it (the page hides the tab too). */
  capability?: string
}

export interface RouteMeta {
  path: string
  section: PageSection | 'home'
  labelKey: string
  titleKey: string
  icon: LucideIcon
  inSidebar: boolean
  /** Extra paths that light this route's sidebar row. */
  activeFor?: string[]
  capability?: string
  requiresServer?: boolean
  requiresLocal?: boolean
  /** Still usable on a remote server once its Server folder is mirrored over SFTP. */
  allowRemoteConfigMirror?: boolean
  shortcut?: string
  /** The main container's width: max-w-7xl, full width, or max-w-3xl. */
  layout?: 'default' | 'wide' | 'narrow'
  loader: { variant: PageSkeletonVariant; descriptionKey: string }
  /** Sub-sections the command palette can open directly (?param=id). */
  deepLinks?: { param: string; items: RouteDeepLinkItem[] }
  /** The page module, for React.lazy and hover preloading. */
  load: () => Promise<{ default: ComponentType }>
}

export const ROUTES: RouteMeta[] = [
  {
    path: '/',
    section: 'home',
    labelKey: 'shell:nav.dashboard',
    titleKey: 'shell:nav.dashboard',
    icon: Gauge,
    inSidebar: true,
    shortcut: '1',
    loader: { variant: 'dashboard', descriptionKey: 'shell:routes.dashboardDescription' },
    load: () => import('../pages/Dashboard'),
  },
  // SERVER: the server chosen in the active-server strip.
  {
    path: '/console',
    section: 'server',
    labelKey: 'shell:nav.items.serverConsole',
    titleKey: 'console:pageHeader.title',
    icon: Terminal,
    inSidebar: true,
    requiresServer: true,
    shortcut: '2',
    layout: 'wide',
    loader: { variant: 'console', descriptionKey: 'console:pageHeader.description' },
    load: () => import('../pages/Console'),
  },
  {
    path: '/server-config',
    section: 'server',
    labelKey: 'shell:nav.items.serverConfiguration',
    titleKey: 'serverconfig:pageHeader.title',
    icon: FileCog,
    inSidebar: true,
    requiresServer: true,
    requiresLocal: true,
    allowRemoteConfigMirror: true,
    shortcut: '8',
    loader: { variant: 'form', descriptionKey: 'serverconfig:pageHeader.description' },
    deepLinks: {
      param: 'tab',
      items: [
        { id: 'ini', labelKey: 'serverconfig:tabs.serverSettings' },
        { id: 'sandbox', labelKey: 'serverconfig:tabs.sandbox' },
        { id: 'spawnpoints', labelKey: 'serverconfig:tabs.spawnPoints' },
        { id: 'spawnregions', labelKey: 'serverconfig:tabs.spawnRegions' },
        { id: 'modsettings', labelKey: 'serverconfig:tabs.modSettings' },
      ],
    },
    load: () => import('../pages/ServerConfig'),
  },
  {
    path: '/mods',
    section: 'server',
    labelKey: 'shell:nav.items.modManager',
    titleKey: 'mods:pageHeader.title',
    icon: Package,
    inSidebar: true,
    requiresServer: true,
    requiresLocal: true,
    shortcut: '6',
    loader: { variant: 'list', descriptionKey: 'mods:pageHeader.description' },
    deepLinks: {
      param: 'view',
      items: [
        { id: 'installed', labelKey: 'mods:nav.installed.label' },
        { id: 'deactivated', labelKey: 'mods:nav.deactivated.label' },
        { id: 'active', labelKey: 'mods:nav.active.label' },
        { id: 'order', labelKey: 'mods:nav.order.label' },
        { id: 'conflicts', labelKey: 'mods:nav.conflicts.label' },
        { id: 'collection', labelKey: 'mods:nav.collection.label' },
        { id: 'presets', labelKey: 'mods:nav.presets.label' },
        { id: 'tools', labelKey: 'mods:nav.tools.label' },
      ],
    },
    load: () => import('../pages/Mods'),
  },
  {
    path: '/files',
    section: 'server',
    labelKey: 'shell:nav.items.serverFiles',
    titleKey: 'files:page.title',
    icon: FolderTree,
    inSidebar: true,
    // Remote servers too: their folders are browsed over the PanelBridge SFTP login.
    requiresServer: true,
    capability: 'files.manage',
    layout: 'wide',
    loader: { variant: 'list', descriptionKey: 'files:page.description' },
    load: () => import('../pages/Files'),
  },
  {
    path: '/templates',
    section: 'server',
    labelKey: 'shell:nav.items.templates',
    titleKey: 'templates:pageHeader.title',
    icon: LayoutTemplate,
    inSidebar: true,
    requiresServer: true,
    requiresLocal: true,
    allowRemoteConfigMirror: true,
    loader: { variant: 'list', descriptionKey: 'templates:pageHeader.description' },
    load: () => import('../pages/Templates'),
  },
  {
    path: '/scheduler',
    section: 'server',
    labelKey: 'shell:nav.items.scheduledTasks',
    titleKey: 'scheduler:pageHeader.title',
    icon: Clock,
    inSidebar: true,
    requiresServer: true,
    loader: { variant: 'list', descriptionKey: 'scheduler:pageHeader.description' },
    load: () => import('../pages/Scheduler'),
  },
  // PLAYERS: moderation is the most frequent crisis task, so it comes first.
  {
    path: '/players',
    section: 'players',
    labelKey: 'shell:nav.items.onlinePlayers',
    titleKey: 'players:pageHeader.title',
    icon: Users,
    inSidebar: true,
    requiresServer: true,
    shortcut: '3',
    loader: { variant: 'list', descriptionKey: 'players:pageHeader.description' },
    load: () => import('../pages/Players'),
  },
  {
    path: '/chat',
    section: 'players',
    labelKey: 'shell:nav.items.inGameChat',
    titleKey: 'chat:pageHeader.title',
    icon: MessagesSquare,
    inSidebar: true,
    requiresServer: true,
    shortcut: '4',
    loader: { variant: 'console', descriptionKey: 'chat:pageHeader.description' },
    load: () => import('../pages/Chat'),
  },
  {
    path: '/leaderboard',
    section: 'players',
    labelKey: 'shell:nav.items.leaderboard',
    titleKey: 'leaderboard:page.title',
    icon: Trophy,
    inSidebar: true,
    requiresServer: true,
    loader: { variant: 'list', descriptionKey: 'leaderboard:page.description' },
    load: () => import('../pages/Leaderboard'),
  },
  // WORLD
  {
    path: '/world-map',
    section: 'world',
    labelKey: 'shell:nav.items.worldMap',
    titleKey: 'worldMap:pageHeader.title',
    icon: MapIcon,
    inSidebar: true,
    requiresServer: true,
    layout: 'wide',
    loader: { variant: 'map', descriptionKey: 'worldMap:pageHeader.description' },
    load: () => import('../pages/WorldMap'),
  },
  {
    path: '/events',
    section: 'world',
    labelKey: 'shell:nav.items.eventsWeather',
    titleKey: 'events:pageHeader.title',
    icon: Zap,
    inSidebar: true,
    requiresServer: true,
    shortcut: '5',
    loader: { variant: 'form', descriptionKey: 'events:pageHeader.description' },
    deepLinks: {
      param: 'section',
      items: [
        'rain', 'severe', 'climate', 'visual', 'clock', 'timespeed', 'utilities',
        'quickSounds', 'targetedSounds', 'horde', 'vehicles', 'teleport', 'broadcast', 'bridgeOps',
      ].map((id) => ({ id, labelKey: `events:sections.${id}.label` })),
    },
    load: () => import('../pages/Events'),
  },
  {
    path: '/backups',
    section: 'world',
    labelKey: 'shell:nav.items.worldBackups',
    titleKey: 'backups:pageHeader.title',
    icon: Archive,
    inSidebar: true,
    requiresServer: true,
    requiresLocal: true,
    shortcut: '7',
    loader: { variant: 'list', descriptionKey: 'backups:pageHeader.description' },
    load: () => import('../pages/Backups'),
  },
  {
    path: '/chunks',
    section: 'world',
    labelKey: 'shell:nav.items.mapCleanup',
    titleKey: 'chunkCleaner:pageHeader.title',
    icon: Eraser,
    inSidebar: true,
    requiresServer: true,
    requiresLocal: true,
    layout: 'wide',
    loader: { variant: 'map', descriptionKey: 'chunkCleaner:pageHeader.description' },
    load: () => import('../pages/ChunkCleaner'),
  },
  // PANEL: what spans servers or concerns the panel itself.
  {
    path: '/servers',
    section: 'panel',
    labelKey: 'shell:nav.items.myServers',
    titleKey: 'servers:pageHeader.title',
    icon: Layers,
    inSidebar: true,
    activeFor: ['/server-setup'],
    loader: { variant: 'list', descriptionKey: 'servers:pageHeader.description' },
    load: () => import('../pages/Servers'),
  },
  {
    path: '/discord',
    section: 'panel',
    labelKey: 'shell:nav.items.discord',
    titleKey: 'discord:management.pageHeaderTitle',
    icon: MessageSquare,
    inSidebar: true,
    loader: { variant: 'form', descriptionKey: 'discord:management.pageHeaderDescription' },
    load: () => import('../pages/Discord'),
  },
  {
    path: '/settings',
    section: 'panel',
    labelKey: 'shell:nav.items.panelSettings',
    titleKey: 'settings:pageHeader.title',
    icon: Settings,
    inSidebar: true,
    shortcut: '9',
    loader: { variant: 'form', descriptionKey: 'settings:pageHeader.defaultDescription' },
    deepLinks: {
      param: 'tab',
      items: [
        { id: 'general', labelKey: 'settings:tabs.general.label' },
        { id: 'updates', labelKey: 'settings:tabs.updates.label' },
        { id: 'https', labelKey: 'settings:tabs.https.label' },
        { id: 'access', labelKey: 'settings:tabs.access.label' },
        { id: 'security', labelKey: 'settings:tabs.security.label' },
        { id: 'users', labelKey: 'settings:tabs.users.label', capability: 'users.manage' },
        { id: 'roles', labelKey: 'settings:tabs.roles.label', capability: 'roles.manage' },
        { id: 'sso', labelKey: 'settings:tabs.sso.label', capability: 'panel.settings' },
        { id: 'connection', labelKey: 'settings:tabs.connection.label' },
        { id: 'bridge', labelKey: 'settings:tabs.bridge.label' },
        { id: 'mods', labelKey: 'settings:tabs.mods.label' },
        { id: 'backups', labelKey: 'settings:tabs.backups.label' },
        { id: 'about', labelKey: 'settings:tabs.about.label' },
      ],
    },
    load: () => import('../pages/Settings'),
  },
  {
    path: '/debug',
    section: 'panel',
    labelKey: 'shell:nav.items.debugLogs',
    titleKey: 'debug:pageHeader.title',
    icon: Bug,
    inSidebar: true,
    loader: { variant: 'console', descriptionKey: 'debug:pageHeader.description' },
    deepLinks: {
      param: 'tab',
      items: [
        { id: 'diagnostics', labelKey: 'debug:tabs.diagnostics' },
        { id: 'health', labelKey: 'debug:tabs.health' },
        { id: 'performance', labelKey: 'debug:tabs.performance' },
        { id: 'activity', labelKey: 'debug:tabs.activity' },
        { id: 'logs', labelKey: 'debug:tabs.logs' },
        { id: 'crashes', labelKey: 'debug:tabs.crashes' },
        { id: 'worldmap', labelKey: 'debug:tabs.worldMap' },
        { id: 'bridge', labelKey: 'debug:tabs.bridge' },
        { id: 'system', labelKey: 'debug:tabs.system' },
      ],
    },
    load: () => import('../pages/Debug'),
  },
  {
    path: '/server-finder',
    section: 'panel',
    labelKey: 'shell:nav.items.browsePublic',
    titleKey: 'serverFinder:pageHeader.title',
    icon: Search,
    inSidebar: true,
    loader: { variant: 'list', descriptionKey: 'serverFinder:pageHeader.description' },
    load: () => import('../pages/ServerFinder'),
  },
  // Not in the sidebar: reached from Servers, the active-server menu, the
  // no-server banner and the palette.
  {
    path: '/server-setup',
    section: 'panel',
    labelKey: 'shell:nav.items.serverSetup',
    titleKey: 'shell:nav.items.serverSetup',
    icon: Plus,
    inSidebar: false,
    layout: 'narrow',
    loader: { variant: 'form', descriptionKey: 'serverSetup:modeSelect.description' },
    load: () => import('../pages/ServerSetup'),
  },
]

export interface NavSection {
  id: PageSection
  labelKey: string
  accent: 'primary' | 'success' | 'warning' | 'muted'
  paths: string[]
}

const sidebarPaths = (section: PageSection) =>
  ROUTES.filter((route) => route.inSidebar && route.section === section).map((route) => route.path)

export const NAV_SECTIONS: NavSection[] = [
  { id: 'server', labelKey: 'shell:nav.sections.server', accent: 'primary', paths: sidebarPaths('server') },
  { id: 'players', labelKey: 'shell:nav.sections.players', accent: 'success', paths: sidebarPaths('players') },
  { id: 'world', labelKey: 'shell:nav.sections.world', accent: 'warning', paths: sidebarPaths('world') },
  { id: 'panel', labelKey: 'shell:nav.sections.panel', accent: 'muted', paths: sidebarPaths('panel') },
]

/** Old paths that redirect (App.tsx) and preload as their new route. */
export const ROUTE_ALIASES: Record<string, string> = {
  '/dashboard': '/',
  '/chunk-cleaner': '/chunks',
  '/serverconfig': '/server-config',
}

const BY_PATH = new Map(ROUTES.map((route) => [route.path, route]))

export function getRouteMeta(pathname: string): RouteMeta | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return BY_PATH.get(ROUTE_ALIASES[path] ?? path)
}

/** The route whose sidebar row is lit on `pathname` (its own, or one that lists it in activeFor). */
export function getActiveSidebarRoute(pathname: string): RouteMeta | undefined {
  const own = getRouteMeta(pathname)
  if (own?.inSidebar) return own
  return ROUTES.find((route) => route.inSidebar && route.activeFor?.includes(own?.path ?? pathname))
}

/**
 * The registry entry for `pathname`, or for the current location. Safe
 * outside a router (it then returns undefined), so components like
 * PageHeader render in isolation too.
 */
export function useRouteMeta(pathname?: string): RouteMeta | undefined {
  const locationContext = useContext(UNSAFE_LocationContext) as { location?: { pathname: string } } | null
  const path = pathname ?? locationContext?.location?.pathname
  return path === undefined ? undefined : getRouteMeta(path)
}

export interface AvailabilityContext {
  can: (capability: string) => boolean
  /** Only a confirmed empty server list blocks; unknown (still loading, failed) never does. */
  serversConfirmedEmpty: boolean
  activeServer?: { isRemote?: boolean; remoteConfigConfigured?: boolean } | null
}

export type RouteAvailability =
  | { state: 'hidden' }
  | { state: 'disabled'; reasonKey: 'shell:nav.requiresServer' | 'shell:nav.notAvailableRemote' }
  | { state: 'enabled' }

/**
 * Whether a route shows, shows disabled with a reason, or is hidden. One
 * rule for the sidebar and the palette. A missing capability hides
 * (can() fails open while capabilities load); needing a server or a local
 * one disables with the reason.
 */
export function routeAvailability(route: RouteMeta, ctx: AvailabilityContext): RouteAvailability {
  if (route.capability && !ctx.can(route.capability)) return { state: 'hidden' }
  if (route.requiresServer && ctx.serversConfirmedEmpty) return { state: 'disabled', reasonKey: 'shell:nav.requiresServer' }
  const remote = !!ctx.activeServer?.isRemote
  if (route.requiresLocal && remote && !(route.allowRemoteConfigMirror && ctx.activeServer?.remoteConfigConfigured)) {
    return { state: 'disabled', reasonKey: 'shell:nav.notAvailableRemote' }
  }
  return { state: 'enabled' }
}
