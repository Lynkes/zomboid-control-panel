import { getRouteMeta } from './navigation'

// Warms a page's module on hover/focus of a link to it, so the click lands
// on code that is already loaded. The loaders come from the route registry.
const preloadedRoutes = new Set<string>()

export function preloadRouteModule(pathname: string) {
  const route = getRouteMeta(pathname.split(/[?#]/)[0])
  if (!route || preloadedRoutes.has(route.path)) return

  preloadedRoutes.add(route.path)
  void route.load().catch(() => {
    preloadedRoutes.delete(route.path)
  })
}
