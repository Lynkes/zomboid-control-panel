import rawPoi from './worldMapPoi.json'

export const WORLD_MAP_CATEGORIES = [
  'town',
  'medical',
  'police',
  'fire',
  'gun',
  'shop',
  'gas',
  'military',
  'landmark',
  'industrial',
] as const

export type WorldMapCategory = typeof WORLD_MAP_CATEGORIES[number]
export type WorldMapVersion = 'B41' | 'B42'
export const MAX_WORLD_MAP_QUERY_LENGTH = 120

const MAX_WORLD_MAP_RESULTS = 100

const B42_ONLY_LANDMARKS = new Set([
  'brandenburg',
  'echo creek',
  'ekron',
  'irvington',
])

export interface WorldMapLocation {
  id: string
  name: string
  category: WorldMapCategory
  x: number
  y: number
  town: string
  description?: string
  tags: string[]
  aliases?: string[]
}

interface PzMapPoi {
  ID: string
  name: string
  description: string
  x: number
  y: number
  location: string
  tags: string[]
}

// The index is the MIT-licensed html/poi.json published by CalvyPZ/PZmap.
// It is the B42 index; there is no corresponding B41 source in that project.
// Its coordinates are Project Zomboid game tiles, the same coordinate system
// used by player markers and the panel's B42 map projection.
const POI_ALIASES: Record<string, string[]> = {
  '3009': ['LV'],
}

const normalizeLocationText = (value: string) =>
  value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

function isPzMapPoi(value: unknown): value is PzMapPoi {
  if (!value || typeof value !== 'object') return false
  const poi = value as Record<string, unknown>
  return (
    typeof poi.ID === 'string' && poi.ID.length > 0 &&
    typeof poi.name === 'string' && poi.name.trim().length > 0 &&
    typeof poi.description === 'string' &&
    typeof poi.x === 'number' && Number.isFinite(poi.x) &&
    typeof poi.y === 'number' && Number.isFinite(poi.y) &&
    typeof poi.location === 'string' && poi.location.trim().length > 0 &&
    Array.isArray(poi.tags) && poi.tags.every((tag) => typeof tag === 'string')
  )
}

function inferCategory(poi: PzMapPoi): WorldMapCategory {
  const tags = new Set(poi.tags.map(normalizeLocationText))
  const text = normalizeLocationText([
    poi.name,
    poi.description,
    poi.location,
    ...poi.tags,
  ].join(' '))
  const has = (...terms: string[]) => terms.some((term) => text.includes(normalizeLocationText(term)))

  if (tags.has('town') || tags.has('city') || tags.has('region')) return 'town'
  if (has('fire department', 'fire departament', 'fire station') || tags.has('fire')) return 'fire'
  if (has('hospital', 'medical', 'doctor', 'pharmacy', 'clinic', 'dentist', 'nursing home', 'veterinarian')) return 'medical'
  if (has('police', 'prison', 'sheriff', 'courthouse', 'court house', 'court of justice', 'law office')) return 'police'
  if (has('army', 'military', 'bunker', 'checkpoint', 'refugee camp', 'refugee area', 'barracks')) return 'military'
  if (has('gun store', 'firearm', 'hunting store', 'shooting range', 'weapons', 'surplus store')) return 'gun'
  if (has('gas station', 'gas-2-go', 'fossoil', 'fuel')) return 'gas'
  if (has('warehouse', 'factory', 'workshop', 'industrial', 'lumber mill', 'rail yard', 'train yard', 'depot', 'substation', 'construction site')) return 'industrial'
  if (has('store', 'shop', 'market', 'mart', 'restaurant', 'diner', 'bar', 'cafe', 'coffee', 'bakery', 'grocery', 'supermarket', 'clothing', 'book', 'hardware', 'furniture', 'liquor', 'vhs', 'post office', 'salon', 'hotel', 'motel', 'garage', 'repair', 'dealership', 'office', 'bank')) return 'shop'
  return 'landmark'
}

const seenPoiIds = new Set<string>()
const seenPoiLocations = new Set<string>()

export const WORLD_MAP_LOCATIONS: WorldMapLocation[] = (Array.isArray(rawPoi) ? rawPoi : [])
  .filter(isPzMapPoi)
  .filter((poi) => {
    if (seenPoiIds.has(poi.ID)) return false
    seenPoiIds.add(poi.ID)
    const locationKey = [
      normalizeLocationText(poi.name.trim()),
      normalizeLocationText(poi.location.trim()),
      poi.x,
      poi.y,
    ].join('|')
    if (seenPoiLocations.has(locationKey)) return false
    seenPoiLocations.add(locationKey)
    return true
  })
  .map((poi) => ({
    id: poi.ID,
    name: poi.name.trim(),
    category: inferCategory(poi),
    x: poi.x,
    y: poi.y,
    town: poi.location.trim(),
    description: poi.description.trim() || undefined,
    tags: poi.tags,
    aliases: POI_ALIASES[poi.ID],
  }))

export function isWorldMapLocationAvailable(
  mapVersion: WorldMapVersion,
): boolean {
  return mapVersion === 'B42'
}

export function isWorldMapLandmarkAvailable(
  name: string,
  mapVersion: WorldMapVersion,
): boolean {
  return mapVersion === 'B42' || !B42_ONLY_LANDMARKS.has(normalizeLocationText(name.trim()))
}

export function searchWorldMapLocations(
  query: string,
  category: WorldMapCategory | 'all' = 'all',
  limit = 25,
  mapVersion: WorldMapVersion = 'B42',
): WorldMapLocation[] {
  const normalizedQuery = normalizeLocationText(query.trim().slice(0, MAX_WORLD_MAP_QUERY_LENGTH))
  const resultLimit = Number.isFinite(limit)
    ? Math.min(MAX_WORLD_MAP_RESULTS, Math.max(0, Math.floor(limit)))
    : 25
  if (resultLimit === 0) return []

  const queryTokens = normalizedQuery.split(/[\s(),-]+/).filter(Boolean)
  return WORLD_MAP_LOCATIONS
    .filter(() => isWorldMapLocationAvailable(mapVersion))
    .filter((location) => category === 'all' || location.category === category)
    .map((location) => {
      const candidates = [
        { value: location.name, weight: 1 },
        ...(location.aliases ?? []).map((value) => ({ value, weight: 1 })),
        { value: location.town, weight: 0.8 },
        ...(location.description ? [{ value: location.description, weight: 0.6 }] : []),
        ...location.tags.map((value) => ({ value, weight: 0.65 })),
      ]
      const normalizedHaystack = normalizeLocationText(candidates.map((candidate) => candidate.value).join(' '))
      const matchesEveryToken = queryTokens.every((token) => normalizedHaystack.includes(token))
      const candidateScore = candidates.reduce((best, candidate) => {
        const normalizedCandidate = normalizeLocationText(candidate.value)
        if (normalizedCandidate === normalizedQuery) return Math.max(best, 120 * candidate.weight)
        if (normalizedCandidate.startsWith(normalizedQuery)) return Math.max(best, 100 * candidate.weight)
        if (normalizedCandidate.split(/[\s(),-]+/).some((part) => part.startsWith(normalizedQuery))) return Math.max(best, 80 * candidate.weight)
        if (normalizedCandidate.includes(normalizedQuery)) return Math.max(best, 60 * candidate.weight)
        return best
      }, 0)
      const score = !normalizedQuery
        ? 1
        : !matchesEveryToken
          ? 0
          : candidateScore + (queryTokens.length > 1 ? 20 : 0)
      return { location, score }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.location.name.localeCompare(right.location.name))
    .slice(0, resultLimit)
    .map(({ location }) => location)
}

export const WORLD_MAP_CATEGORY_LABELS: Record<WorldMapCategory, string> = {
  town: 'Towns',
  medical: 'Medical',
  police: 'Police',
  fire: 'Fire',
  gun: 'Guns',
  shop: 'Shops',
  gas: 'Gas',
  military: 'Military',
  landmark: 'Landmarks',
  industrial: 'Industrial',
}
