import { apiFetch, handleResponse } from '@/lib/api'

// Types and fetcher for GET /api/player-character/:username (server:
// routes/playerCharacter.js, services/characterSheet.js, characterHints.js).
// Every field of a sheet is optional: the bridge leaves out any value it
// couldn't read instead of sending a 0, and a section that wasn't asked for
// is absent altogether.

export type CharacterSection = 'summary' | 'stats' | 'skills' | 'traits' | 'inventory'
export const BASE_CHARACTER_SECTIONS: CharacterSection[] = ['summary', 'stats', 'skills', 'traits']

export type CharacterAvailability = 'live' | 'partial' | 'playerOffline' | 'bridgeOffline' | 'timeout'

export interface CharacterRole {
  name?: string
  adminPower?: boolean
  canSpawnItems?: boolean
}

export const CHARACTER_FLAGS = [
  'godMode',
  'invisible',
  'noClip',
  'ghostMode',
  'unlimitedCarry',
  'unlimitedEndurance',
  'knowAllRecipes',
  'invincible',
] as const
export type CharacterFlag = (typeof CHARACTER_FLAGS)[number]

export interface CharacterSummary {
  isAlive?: boolean
  isAsleep?: boolean
  isSneaking?: boolean
  isRunning?: boolean
  x?: number
  y?: number
  z?: number
  hoursSurvived?: number
  minutesPerDay?: number
  zombieKills?: number
  survivorKills?: number
  bodyWeight?: number
  carriedWeight?: number
  maxWeight?: number
  flags?: Partial<Record<CharacterFlag, boolean>>
  profession?: { id?: string; label?: string }
  xpSandbox?: { global?: number; globalToggle?: boolean }
}

export const CHARACTER_STATS = [
  'hunger',
  'thirst',
  'fatigue',
  'endurance',
  'stress',
  'boredom',
  'unhappiness',
  'panic',
  'pain',
  'sickness',
  'zombieInfection',
  'wetness',
  'intoxication',
] as const
export type CharacterStatName = (typeof CHARACTER_STATS)[number]

export interface CharacterStatValue {
  value: number
  min?: number
  max?: number
}

export interface CharacterHealth {
  overall?: number
  isInfected?: boolean
  numPartsBleeding?: number
  isBleeding?: boolean
  temperature?: number
}

export interface CharacterPerkCategory {
  id: string
  name?: string
}

export interface CharacterPerk {
  id: string
  parent?: string
  name?: string
  passive?: boolean
  level?: number
  xp?: number
  levelXp?: number
  nextLevelXp?: number
  boost?: number
  multiplier?: number
  sandboxMultiplier?: number
}

export interface CharacterSkills {
  categories: CharacterPerkCategory[]
  perks: CharacterPerk[]
  failed?: number
}

export interface CharacterTrait {
  id: string
  label?: string
  cost?: number
  profession?: boolean
}

interface CharacterRowPlacement {
  worn?: boolean
  equipped?: 'primary' | 'secondary'
  attached?: string
}

export interface CharacterStackRow extends CharacterRowPlacement {
  kind: 'stack'
  fullType?: string
  name?: string
  category?: string
  qty?: number
  weight?: number
  condition?: number
  conditionMax?: number
  modId?: string
  hidden?: boolean
  obsolete?: boolean
}

export interface CharacterContainerRow extends CharacterRowPlacement {
  kind: 'container'
  id?: string
  itemId?: string
  fullType?: string
  name?: string
  weight?: number
  contentsWeight?: number
  capacity?: number
  itemCount?: number
  truncatedDepth?: boolean
  rows: CharacterRow[]
}

export type CharacterRow = CharacterStackRow | CharacterContainerRow

export interface CharacterInventoryTotals {
  walked?: number
  itemCount?: number
  distinctTypes?: number
  skipped?: number
  truncated?: boolean
  truncatedReason?: string
  maxItems?: number
  maxDepth?: number
  budgetMs?: number
}

export interface CharacterInventory {
  root?: CharacterContainerRow
  worn: CharacterRow[]
  equipped: { primary?: CharacterRow; secondary?: CharacterRow }
  attached: CharacterRow[]
  totals: CharacterInventoryTotals
}

export interface CharacterSheet {
  schema?: number
  generatedAt?: number
  username?: string
  displayName?: string
  forename?: string
  surname?: string
  role?: CharacterRole
  summary?: CharacterSummary
  stats?: Partial<Record<CharacterStatName, CharacterStatValue>>
  health?: CharacterHealth
  skills?: CharacterSkills
  traits?: CharacterTrait[]
  inventory?: CharacterInventory
  cost?: { ms?: number; walked?: number }
  sectionErrors?: Partial<Record<CharacterSection | 'health', string>>
}

export interface CharacterRecord {
  allTimeKills: number | null
  deaths: number | null
  bestDays: number | null
  currentKills: number | null
  currentDays: number | null
  favoriteWeapon: string | null
}

export interface CharacterSkillDelta {
  since: string
  source: 'view' | 'login' | 'sampler'
  perks: Array<{ id: string; fromLevel: number; toLevel: number; fromXp?: number; toXp?: number }>
}

export const CHARACTER_HINT_IDS = [
  'powersOnRegularAccount',
  'debugItems',
  'skillJump',
  'skillsAheadOfTime',
  'manyMaxedSkills',
  'overCapacity',
  'unusualQuantity',
  'hiddenItems',
  'obsoleteItems',
] as const
export type CharacterHintId = (typeof CHARACTER_HINT_IDS)[number]

export interface CharacterHintEvidence {
  kind: 'perk' | 'item' | 'flag'
  ref: string
  detail?: {
    level?: number
    from?: number
    to?: number
    qty?: number
    name?: string
    given?: number
    givenAt?: string
  }
}

export interface CharacterHint {
  id: CharacterHintId
  weight: 'strong' | 'mild'
  params: Record<string, number | string | boolean | undefined>
  evidence: CharacterHintEvidence[]
  explainedBy?: Array<{ action: string; at: string; details: string }>
  staff: boolean
  source: 'live' | 'cached'
}

export interface CharacterHintThresholds {
  advancedLevelFloor: number
  advancedLevelsPerHour: number
  advancedLevelsGrace: number
  bookMultiplierWeight: number
  maxedSkillsCount: number
  maxedSkillsStrongCount: number
  maxedSkillsWithinHours: number
  maxedSkillsShareAlways: number
  jumpLevelsOnePerk: number
  jumpMinTargetLevel: number
  jumpLevelsPassive: number
  jumpTotalLevels: number
  jumpWindowMinutes: number
  jumpRawXpFloor: number
  unusualQuantity: number
  overCapacityFactor: number
}

export interface CharacterSheetResponse {
  username: string
  serverId: string | null
  availability: CharacterAvailability
  transport: 'local' | 'sftp' | null
  refreshAfterMs: number
  inventoryRefreshAfterMs: number
  fetchedAt: string
  sheet: CharacterSheet | null
  /** statsAt: when the saved Condition (stats and health) was read, which can be older than `at`. */
  cached: { at: string; inventoryAt: string | null; statsAt?: string | null; sheet: CharacterSheet } | null
  record: CharacterRecord | null
  skillDelta: CharacterSkillDelta | null
  hints: CharacterHint[]
  hintSource: 'live' | 'cached' | null
  /** Set when live item hints come from an inventory read this long ago; those hints have source 'cached'. */
  hintInventoryAt?: string | null
  hintThresholds: CharacterHintThresholds
  cost?: { ms: number; walked: number }
}

// A bridge read over SFTP can take the bridge's full 60 s command timeout, and
// the leaderboard runs beside it: well past apiFetch's 15 s default.
const CHARACTER_FETCH_TIMEOUT_MS = 75000

export async function getCharacterSheet(
  username: string,
  options: { sections?: CharacterSection[]; fresh?: boolean; maxItems?: number; signal?: AbortSignal } = {},
): Promise<CharacterSheetResponse> {
  const params = new URLSearchParams()
  if (options.sections && options.sections.length > 0) params.set('sections', options.sections.join(','))
  if (options.fresh) params.set('fresh', '1')
  if (options.maxItems !== undefined) params.set('maxItems', String(options.maxItems))
  const query = params.toString()
  // No transport retries: the tab polls on its own, a failed read shows a
  // Retry button, and three retries of a 75 s bridge read would take minutes.
  const response = await apiFetch(
    `/player-character/${encodeURIComponent(username)}${query ? `?${query}` : ''}`,
    { signal: options.signal, timeout: CHARACTER_FETCH_TIMEOUT_MS, retries: 0 },
  )
  return handleResponse<CharacterSheetResponse>(response)
}

/** Hints that still need a look: not explained by a panel action. */
export function unexplainedHintCount(hints: CharacterHint[] | undefined): number {
  return (hints ?? []).filter((hint) => !hint.explainedBy || hint.explainedBy.length === 0).length
}
