import { useState, useEffect, useMemo, useCallback, useRef, useDeferredValue, memo, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useSearchParams, Link } from 'react-router-dom'
import { copyText, cn } from '@/lib/utils'
import {
  Settings,
  FileText,
  MapPin,
  Map,
  Save,
  RefreshCw,
  Search,
  Code,
  FormInput,
  Puzzle,
  Loader2,
  CheckCircle,
  AlertCircle,
  History,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  ExternalLink,
  Download,
  Upload,
  RotateCcw,
  AlertTriangle,
  Copy,
  Check,
  Filter,
  Bookmark,
  FolderOpen,
  FolderTree,
  HelpCircle,
  LayoutTemplate,
  X,
  Undo2,
  Globe,
  Swords,
  MessageSquare,
  Users,
  Home,
  Package,
  Cloud,
  Mic,
  MessageCircle,
  Terminal,
  Archive,
  Car,
  Shield,
  Wrench,
  Radio,
  Clock,
  Gem,
  Heart,
  Crosshair,
  Leaf,
  Compass,
  Skull,
  TrendingUp,
  BarChart,
  Layers,
  type LucideIcon
} from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { reportClientError } from '@/lib/client-errors'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { HelpTip } from '@/components/HelpTip'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
// AlertDialog imports available if needed for save confirmation
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { PageHeader } from '@/components/PageHeader'
import { PageAlerts, type PageAlert } from '@/components/PageAlerts'
import { SaveBar } from '@/components/SaveBar'
import { SectionCard } from '@/components/ui/section-card'
import { SubNav, SubNavLayout, type SubNavGroup } from '@/components/ui/sub-nav'
import { StatusPill } from '@/components/ui/status-pill'
import { Toolbar } from '@/components/ui/toolbar'
import { Segmented } from '@/components/ui/segmented'
import { RowActions, type RowActionItem } from '@/components/ui/row-actions'
import { Skeleton } from '@/components/ui/skeleton'
import { useUrlParamState } from '@/hooks/useUrlParamState'
import { useGuardedNavigate, useUnsavedChangesGuard } from '@/contexts/UnsavedChangesContext'
import { serverApi, serverFilesApi, serversApi, panelBridgeApi, ApiError, SpawnPointsByProfession, SpawnRegion, SandboxData, ConfigTemplate, WorldSandboxSnapshot, LiveWorldSandboxSnapshot, BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS } from '@/lib/api'
import { liveWorldSandboxOutcome } from '@/lib/worldSandbox'
import { resolveServerRunning } from '@/lib/serverStatus'
import { getBridgeVerifiedState } from '@/lib/bridgeVerify'
import { isDeliveryStatus, resolveLuaChecksumCallout, type LuaChecksumDelivery } from '@/lib/bridgeDeliveryView'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useDateFormat } from '@/lib/dateFormat'
import { formatModSettingDescription, formatModSettingLabel } from '@/lib/modSettingsLabels'
import {
  buildIniSavePayload,
  findIniFatalLines,
  iniValueIsDefault,
  javaTrim,
  mergeIniSchemaDefaults,
  parseIniNumber,
  parsePzBoolean,
  pzNumberHasStraySpace,
  pzNumberText,
  pzOptionText,
  showIniWhitespace,
} from '@/lib/iniFormState'
import { EmptyState } from '@/components/EmptyState'
import { useAuth } from '@/contexts/AuthContext'
import { useSocket } from '@/contexts/SocketContext'
import { useRequestGuard } from '@/hooks/useRequestGuard'
import { DisabledReason } from '@/components/DisabledReason'
import {
  INI_SCHEMA,
  INI_CATEGORIES,
  INI_CATEGORY_GROUPS,
  SANDBOX_SCHEMA,
  SANDBOX_CATEGORIES,
  SANDBOX_CATEGORY_GROUPS,
  normalizeNumericInput,
  parseNumericSettingValue,
  IniSetting,
  SandboxSetting,
  groupByCategory,
  getIniSettingLabel,
  getIniSettingDescription,
  getIniSettingOptionLabel,
  getIniSettingSearchText,
  getIniCategoryLabel,
  getIniCategoryGroupLabel,
  getSandboxSettingLabel,
  getSandboxSettingDescription,
  getSandboxSettingOptionLabel,
  getSandboxSettingSearchText,
  getSandboxCategoryLabel,
  getSandboxCategoryGroupLabel,
  getUnrecognizedSandboxOptionWarning,
  getUnrecognizedIniBooleanWarning,
  getIniMisnamedKeyWarning,
  getIniMisnamedKeyFileValue,
  getIniNumberStraySpaceError,
  getIniSecretCutAtEqualsWarning,
  getIniTextCutAtEqualsWarning,
  getSandboxLiveRangesUnavailableTitle,
  getSandboxLiveRangesUnavailableBody,
  getSandboxOutOfRangeAllowedTitle,
  getSandboxOutOfRangeAllowedBody,
  getAllowOutOfRangeSandboxValues,
  ALLOW_OUT_OF_RANGE_SANDBOX_STORAGE_KEY,
  formatRawConfigValue,
} from '@/lib/serverConfigSchema'

type EditorMode = 'structured' | 'raw'
type FilterMode = 'all' | 'modified' | 'nondefault'
type SandboxScalar = string | number | boolean | null | undefined
type SandboxRecord = Record<string, SandboxScalar>

// PanelBridge enumerates every sandbox option. These are Project Zomboid's
// built-in groups, which belong in the Sandbox editor rather than Mod Settings.
const VANILLA_SANDBOX_GROUPS = new Set([
  'Vanilla',
  'Map',
  'ZombieLore',
  'ZombieConfig',
  'MultiplierConfig',
  'Basement',
])

// getAllSandboxOptions lists at most this many labels per enum: the
// `math.min(numVals, 50)` in PanelBridge.lua. A lower Lua cap would make every
// current bridge with more values look old here and hold its last value back;
// server/tests/sandboxEnumLabelCapParity.test.js keeps the two equal.
const BRIDGE_ENUM_LABEL_CAP = 50

type ModEnumControl = {
  /** Labels for values 1..length, shown as a list. null: type the number. */
  listLabels: string[] | null
  /** The one value the running PanelBridge can't save, or null. */
  blockedValue: number | null
  /** More values than the bridge lists labels for. */
  tooManyToList: boolean
}

/**
 * How Mod Settings edits an enum option. Enum values run 1..N, and the bridge
 * sends N as `max` and label i for value i, with the number standing in for a
 * missing translation so labels never shift.
 *
 * After a panel update a game server can still run the old Lua (PanelBridge
 * 1.7.70 or older): until it restarts, and until the new PanelBridge.lua
 * reaches its game folder (a manual re-upload on hosted and SFTP servers).
 * The old Lua read labels from index 0, which Build 42 always rejects, never
 * asked for N, and dropped labels without a translation, so its list is
 * always shorter than today's. Its setSandboxOption also saves N as N-1 and
 * reports that as confirmed, so N is blocked until PanelBridge is updated.
 * With exactly N-1 labels none was dropped, and they still line up with
 * values 1..N-1.
 */
function describeModEnumControl(opt: { type?: string; enumValues?: string[]; max?: number }): ModEnumControl | null {
  if (opt.type !== 'enum') return null
  const labels = Array.isArray(opt.enumValues) ? opt.enumValues : []
  const max = typeof opt.max === 'number' ? opt.max : undefined
  if (max === undefined) {
    return labels.length > 0 ? { listLabels: labels, blockedValue: null, tooManyToList: false } : null
  }
  if (labels.length === max) return { listLabels: labels, blockedValue: null, tooManyToList: false }
  if (labels.length < Math.min(max, BRIDGE_ENUM_LABEL_CAP)) {
    return {
      listLabels: labels.length > 0 && labels.length === max - 1 ? labels : null,
      blockedValue: max,
      tooManyToList: false,
    }
  }
  return { listLabels: null, blockedValue: null, tooManyToList: labels.length < max }
}

// Kept out of the "other settings in this file" list. The ServerImage* keys
// were shown by older panel releases but Build 42 does not support them.
// BloodSplatLifespanDays is still declared by 42.21's ServerOptions, so a
// generated .ini has the line, but nothing reads that copy: IsoChunk and
// IsoObject read SandboxOptions.bloodSplatLifespanDays, and the game's own
// Server Settings screen only offers the sandbox one -- the Sandbox tab's
// Blood Splat Lifespan is the setting that works.
const UNSUPPORTED_INI_KEYS = new Set([
  'ServerImageLoginScreen',
  'ServerImageLoadingScreen',
  'ServerImageIcon',
  'BloodSplatLifespanDays',
])

function createSandboxDefaults(): SandboxData {
  const sandbox: SandboxData = {
    VERSION: 4,
    settings: {},
    ZombieLore: {},
    ZombieConfig: {},
    MultiplierConfig: {},
    Map: {},
    Basement: {},
  }
  for (const setting of SANDBOX_SCHEMA) {
    const section = (setting.section || 'settings') as keyof SandboxData
    const values = sandbox[section]
    if (typeof values === 'object' && values !== null) {
      values[setting.key] = setting.default ?? ''
    }
  }
  return sandbox
}

// PanelBridge 1.7.72 and older follow a live sandbox-option change with a
// world save (saveGame()) and report it as `persisted`/`saveError` (commit
// b376b2c). Newer bridges don't save at all and send neither field: on a
// dedicated server that save wrote map_sand.bin, which the game loads over
// SandboxVars.lua on every start (#197). persisted===false is a failure an
// older bridge detected and logged; `undefined` must NOT be read as a
// failure -- same old-bridge-safe contract as getBridgeVerifiedState
// (lib/bridgeVerify.ts) applies to `verified`. Exported as a pure predicate
// so this exact contract (only an explicit false warns) is unit-testable
// without mounting the whole page.
export function isWorldSaveFailure(data: { persisted?: unknown } | null | undefined): boolean {
  return data?.persisted === false
}

// server/routes/serverFiles.js's PUT /sandbox reads the SandboxVars.lua file
// back after writing it specifically because a key with no matching line to
// update was silently dropped while the route still reported success --
// attached as `unpersistedKeys` when that happens. The route still returns
// success:true (most of the save DID land), so this is a warning to surface
// alongside the normal saved toast, not a replacement for it. Exported as a
// pure predicate so the decision to warn is unit-testable without mounting
// the whole page.
export function getUnpersistedSandboxKeys(
  data: { unpersistedKeys?: unknown } | null | undefined,
): string[] | null {
  const keys = data?.unpersistedKeys
  return Array.isArray(keys) && keys.length > 0 ? (keys as string[]) : null
}

// server/routes/serverFiles.js's POST /templates/:id/apply tracks each write
// as it actually lands, and attaches that as `partiallyApplied` on the 500
// body when INI succeeded before Sandbox threw (the two settings groups are
// written independently, so one can land while the other fails).
// ApiError.data carries the raw response payload -- read it here rather than
// showing a generic failure that would read as "nothing happened" when part
// of the template is now live on disk. Exported as a pure predicate so the
// decision (partial-apply toast vs. generic failure toast) is unit-testable
// without mounting the whole page.
// server/routes/serverFiles.js's POST /templates/:id/apply can write BOTH
// the INI and the Sandbox file in one call, and attaches a `backupWarnings`
// ARRAY when either write's own backup failed -- one entry per file, so
// both can fail independently and still both be reported. The globally-
// handled `backupWarning` field (singular, a string; see api.ts's shared
// response handler) is a DIFFERENT shape used by ~30 other config-writing
// routes that only ever touch one file per call; that handler does not
// know to look for this route's plural array, so without reading it here
// explicitly, applying a template could overwrite both config files with
// no safety copy and no warning at all. Exported as a pure predicate so
// the decision to warn is unit-testable without mounting the whole page.
export function getApplyTemplateBackupWarnings(
  data: { backupWarnings?: unknown } | null | undefined,
): string[] | null {
  const warnings = data?.backupWarnings
  return Array.isArray(warnings) && warnings.length > 0 ? (warnings as string[]) : null
}

export function getPartiallyAppliedFromApplyTemplateError(error: unknown): string[] | null {
  if (
    error instanceof ApiError &&
    error.data &&
    typeof error.data === 'object' &&
    Array.isArray((error.data as { partiallyApplied?: unknown }).partiallyApplied)
  ) {
    const applied = (error.data as { partiallyApplied: string[] }).partiallyApplied
    return applied.length > 0 ? applied : null
  }
  return null
}

// Auth-aware image preview (img tags can't send Bearer tokens)
function AuthImage({ filePath, alt, className }: { filePath: string; alt?: string; className?: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const blobRef = useRef<string | null>(null)
  useEffect(() => {
    if (!filePath) return
    let cancelled = false
    serverFilesApi.fetchImagePreview(filePath).then(url => {
      if (cancelled) { URL.revokeObjectURL(url); return }
      if (blobRef.current) URL.revokeObjectURL(blobRef.current)
      blobRef.current = url
      setBlobUrl(url)
    }).catch(() => {})
    return () => {
      cancelled = true
      if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null }
    }
  }, [filePath])
  if (!blobUrl) return null
  return <img src={blobUrl} alt={alt || 'Preview'} className={className} />
}

// --- Optimized Row Components ---

const IniSettingRow = memo(({
  setting,
  value,
  originalValue,
  onChange,
  onReset,
  onBrowse,
  allowOutOfRange,
  misnamedAs,
  misnamedFileValue,
  secretCutAtEquals
}: {
  setting: IniSetting;
  value: string;
  originalValue?: string;
  onChange: (key: string, value: string) => void;
  onReset?: (key: string) => void;
  onBrowse?: (key: string, extensions?: string[]) => void;
  /** Settings.tsx's range override toggle; same split as SandboxSettingRow. */
  allowOutOfRange?: boolean;
  /**
   * The option name the game reads on this key's line when that isn't the
   * key ("PVP " for "PVP = true"): the game skips the line, so the row shows
   * the default it uses instead (mergeIniSchemaDefaults) and says why.
   */
  misnamedAs?: string;
  /**
   * The value on that skipped line. A text row shows it under the warning:
   * the field holds the default, and the first edit replaces the line.
   */
  misnamedFileValue?: string;
  /**
   * GET /ini's maskedCutAtEqualsKeys has this key: its value, which the form
   * only has masked, holds an "=" the game stops reading at.
   */
  secretCutAtEquals?: boolean;
}) => {
  const { t } = useTranslation('serverconfig')
  const isModified = originalValue !== undefined && value !== originalValue
  // Against the value the game ends up with (iniValueIsDefault): "MaxPlayers= 32"
  // or a boolean it rejects is still its default.
  const isDifferentFromDefault = setting.default !== undefined && !iniValueIsDefault(setting, String(value ?? ''))
  const numberHasContent = setting.type === 'number' && String(value ?? '').trim() !== ''
  // Read as the game reads it (iniFormState.ts): " 16" is 16, but a
  // no-break space or BOM next to the digits makes the game keep its default.
  const numberIsMalformed = numberHasContent && parseIniNumber(value, setting, { enforceBounds: false }) === null
  const numberOutOfRange = numberHasContent && !numberIsMalformed && parseIniNumber(value, setting) === null
  const numberIsInvalid = numberIsMalformed || (numberOutOfRange && !allowOutOfRange)
  const numberIsRangeWarning = numberOutOfRange && !!allowOutOfRange
  const numberHasStraySpace = numberIsMalformed && pzNumberHasStraySpace(String(value ?? ''))
  // A value the file holds but this select doesn't offer (e.g.
  // BadWordPolicy=4 from before GH#182 dropped the option B42 rejects):
  // show it instead of a blank trigger, same as SandboxSettingRow. Saving
  // never rewrites it unless the operator picks another option. The game
  // reads these selects as numbers, so "BadWordPolicy= 2" is option 2.
  const selectOption = setting.type === 'select'
    ? setting.options?.find((o) => o.value === pzNumberText(String(value ?? '')))
    : undefined
  const selectHasUnrecognizedValue =
    setting.type === 'select' &&
    !!setting.options &&
    String(value ?? '') !== '' &&
    !selectOption
  // Text settings: the game reads a value only up to its next "=", so
  // "PublicDescription=Rules: PvP = off" shows in game as "Rules: PvP ". A
  // masked secret ("••••••••" and its last 4 chars) is checked by GET /ini
  // instead (secretCutAtEquals), and its warning names no part of it: an
  // RCONPassword with an "=" is cut by the game, and RCON login then fails.
  const isTextSetting = setting.type === 'string' || setting.type === 'multiline' || setting.type === 'filepath'
  const textValue = String(value ?? '')
  const textIsMaskedSecret = textValue.startsWith('••••••••')
  let textCutMessage: string | null = null
  if (isTextSetting && textIsMaskedSecret) {
    if (secretCutAtEquals) textCutMessage = getIniSecretCutAtEqualsWarning()
  } else if (isTextSetting && textValue.includes('=')) {
    textCutMessage = getIniTextCutAtEqualsWarning(pzOptionText(textValue))
  }
  const textCutWarning = textCutMessage ? (
    <div className="flex items-start gap-1.5 mt-1.5 text-xs text-warning">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      <span>{textCutMessage}</span>
    </div>
  ) : null
  // What a skipped line holds, on a text row (never a masked secret's mask).
  const misnamedFileText = isTextSetting && misnamedFileValue && !misnamedFileValue.startsWith('••••••••')
    ? javaTrim(misnamedFileValue)
    : ''
  // A legacy (Build 41-only) row keeps the file's value under its Legacy
  // badge (mergeIniSchemaDefaults fills no default for it), and B42 has no
  // such option to skip, so it gets no warning.
  const misnamedWarning = misnamedAs !== undefined && !setting.legacy ? (
    <div className="flex items-start gap-1.5 text-xs text-warning">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p>{getIniMisnamedKeyWarning(showIniWhitespace(misnamedAs))}</p>
        {misnamedFileText && (
          <p className="mt-1 break-words" dir="auto">{getIniMisnamedKeyFileValue(misnamedFileText)}</p>
        )}
      </div>
    </div>
  ) : null
  // The boolean twin: a value PZ's boolean parser rejects (B41's
  // SteamScoreboard=admin) leaves the game on the option's default, so the
  // switch shows that default and the row says the game does not accept the
  // stored value. Saving keeps it unless the operator flips the switch. Not
  // trimmed here: parsePzBoolean trims exactly as the game does.
  const booleanText = String(value ?? '')
  const booleanValue = parsePzBoolean(booleanText)
  const booleanHasUnrecognizedValue = setting.type === 'boolean' && booleanText !== '' && booleanValue === null
  const booleanDefaultOn = setting.default === true
  const booleanChecked = booleanValue ?? booleanDefaultOn

  // Multiline settings
  if (setting.type === 'multiline') {
    return (
      <div className={`perf-content-auto grid gap-2 rounded-md border-b py-3 ps-3 pe-4 transition-colors last:border-0 ${
        isModified ? 'bg-warning/5' : 'hover:bg-muted/20'
      }`}>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">{getIniSettingLabel(setting)}</Label>
            <p className="text-xs text-muted-foreground mt-0.5">{getIniSettingDescription(setting)}</p>
          </div>
          {isModified && onReset && (
            <Button variant="ghost" size="sm" className="h-7 text-xs text-warning hover:text-warning" onClick={() => onReset(setting.key)}>
              <Undo2 className="w-3 h-3 me-1" /> {t('row.reset')}
            </Button>
          )}
        </div>
        <div>
          <Textarea
            value={value}
            onChange={(e) => onChange(setting.key, e.target.value)}
            className={`min-h-[80px] resize-y ${isModified ? 'border-warning/40' : ''}`}
          />
          {textCutWarning}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <code className="bg-muted px-1 rounded">{setting.key}</code>
          {setting.default !== undefined && (
            <span className={isDifferentFromDefault ? 'text-warning' : ''}>{t('row.defaultValue', { value: formatRawConfigValue(setting.default) })}</span>
          )}
        </div>
        {misnamedWarning}
      </div>
    )
  }

  // Standard settings
  return (
    <div className={`perf-content-auto grid gap-2 rounded-md border-b py-3 ps-3 pe-4 transition-colors last:border-0 ${
      isModified ? 'bg-warning/5' : 'hover:bg-muted/20'
    }`}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">{getIniSettingLabel(setting)}</Label>
            {isModified && (
              <Badge variant="warning" className="h-5 text-xs">{t('row.modifiedBadge')}</Badge>
            )}
            {setting.legacy && (
              <Badge variant="outline" className="h-5 text-xs">{t('row.legacyBadge')}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">{getIniSettingDescription(setting)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isModified && onReset && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-11 w-11 text-warning hover:text-warning sm:h-9 sm:w-9" onClick={() => onReset(setting.key)} aria-label={t('row.resetAria', { label: getIniSettingLabel(setting) })}>
                    <Undo2 className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('row.resetToLoadedValue')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <div className={`w-full ${setting.type === 'filepath' ? 'sm:w-72' : 'sm:w-48'}`}>
            {setting.type === 'boolean' ? (
              <div>
                <div className="flex items-center gap-2 justify-end">
                  <span className="text-xs text-muted-foreground">{booleanChecked ? t('row.on') : t('row.off')}</span>
                  <Switch
                    checked={booleanChecked}
                    onCheckedChange={(checked) => onChange(setting.key, checked ? 'true' : 'false')}
                    aria-label={getIniSettingLabel(setting) || setting.key}
                  />
                </div>
                {booleanHasUnrecognizedValue && (
                  <div className="flex items-start gap-1.5 mt-1.5 text-xs text-warning">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{getUnrecognizedIniBooleanWarning(showIniWhitespace(booleanText), booleanDefaultOn)}</span>
                  </div>
                )}
              </div>
            ) : setting.type === 'select' && setting.options ? (
              <div>
                <Select value={selectOption?.value ?? String(value)} onValueChange={(val) => onChange(setting.key, val)}>
                  <SelectTrigger className={selectHasUnrecognizedValue ? 'border-warning/60' : ''}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectHasUnrecognizedValue && (
                      <SelectItem value={String(value)} disabled>
                        {String(value)} (?)
                      </SelectItem>
                    )}
                    {setting.options.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{getIniSettingOptionLabel(setting, opt.value)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectHasUnrecognizedValue && (
                  <div className="flex items-start gap-1.5 mt-1.5 text-xs text-warning">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{getUnrecognizedSandboxOptionWarning(String(value))}</span>
                  </div>
                )}
              </div>
            ) : setting.type === 'number' ? (
              <div>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => {
                    onChange(setting.key, normalizeNumericInput(e.target.value))
                  }}
                  min={setting.min}
                  max={setting.max}
                  aria-invalid={numberIsInvalid}
                  className={`text-end ${isModified ? 'border-warning/40' : ''} ${numberIsInvalid ? 'border-destructive/70' : numberIsRangeWarning ? 'border-warning' : ''}`}
                />
                {(setting.min !== undefined || setting.max !== undefined) && (
                  <div className={`text-xs mt-0.5 flex items-center justify-end gap-1 ${numberIsRangeWarning ? 'text-warning' : 'text-muted-foreground/60'}`}>
                    {numberIsRangeWarning && <AlertTriangle className="h-3 w-3 shrink-0" />}
                    {/* bug-hunt-2026-09-08 (Arabic render pass): rangeMinMax's
                        "{{min}} – {{max}}" is a bare-punctuation number pair,
                        the exact bidi-vulnerable shape -- confirmed reversed
                        in Arabic (a 1-100 field showed "100 - 1"). A lone
                        min or max has no second number to reorder against,
                        so those two branches don't need it. */}
                    {setting.min !== undefined && setting.max !== undefined
                      ? <bdi>{t('row.rangeMinMax', { min: setting.min, max: setting.max })}</bdi>
                      : setting.min !== undefined
                      ? t('row.rangeMin', { min: setting.min })
                      : t('row.rangeMax', { max: setting.max })}
                  </div>
                )}
                {numberHasStraySpace && (
                  <div className="flex items-start gap-1.5 mt-1.5 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{getIniNumberStraySpaceError(showIniWhitespace(pzOptionText(String(value))))}</span>
                  </div>
                )}
              </div>
            ) : setting.type === 'filepath' ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Input
                    value={String(value)}
                    onChange={(e) => onChange(setting.key, e.target.value)}
                    className={`flex-1 font-mono text-xs ${isModified ? 'border-warning/40' : ''}`}
                    placeholder={t('fileBrowserDialog.noImageSelected')}
                    maxLength={512}
                  />
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => onBrowse?.(setting.key, setting.fileExtensions)} aria-label={t('fileBrowserDialog.browseAria')}>
                          <FolderOpen className="w-3.5 h-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('fileBrowserDialog.browseTooltip')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  {value && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => onChange(setting.key, '')} aria-label={t('fileBrowserDialog.clearImageAria')}>
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('fileBrowserDialog.clearImageTooltip')}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
                {value && (
                  <div className="rounded-md border bg-muted/30 p-1.5 max-w-[200px]">
                    <AuthImage
                      filePath={value}
                      alt={getIniSettingLabel(setting)}
                      className="rounded max-h-[80px] w-auto object-contain"
                    />
                  </div>
                )}
                {textCutWarning}
              </div>
            ) : (
              <div>
                <Input
                  value={String(value)}
                  onChange={(e) => onChange(setting.key, e.target.value)}
                  className={isModified ? 'border-warning/40' : ''}
                  maxLength={512}
                />
                {textCutWarning}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <code className="bg-muted px-1 rounded">{setting.key}</code>
        {setting.default !== undefined && (
          <span className={isDifferentFromDefault ? 'text-warning' : ''}>{t('row.defaultValue', { value: formatRawConfigValue(setting.default) })}</span>
        )}
      </div>
      {misnamedWarning}
    </div>
  )
}, (prev, next) => {
  return prev.value === next.value && prev.setting === next.setting && prev.originalValue === next.originalValue && prev.onBrowse === next.onBrowse && prev.allowOutOfRange === next.allowOutOfRange && prev.misnamedAs === next.misnamedAs && prev.misnamedFileValue === next.misnamedFileValue && prev.secretCutAtEquals === next.secretCutAtEquals
})
IniSettingRow.displayName = 'IniSettingRow'

export const SandboxSettingRow = memo(({
  setting,
  value,
  originalValue,
  onChange,
  onReset,
  allowOutOfRange
}: {
  setting: SandboxSetting;
  value: SandboxScalar;
  originalValue?: SandboxScalar;
  onChange: (setting: SandboxSetting, value: SandboxScalar) => void;
  onReset?: (setting: SandboxSetting) => void;
  /** Settings.tsx's sandboxRangeOverride toggle. See invalidSandboxSettings'
   *  own comment above for the blocking-vs-warning split this drives. */
  allowOutOfRange?: boolean;
}) => {
  const { t } = useTranslation('serverconfig')
  const isModified = originalValue !== undefined && JSON.stringify(value) !== JSON.stringify(originalValue)
  const isDifferentFromDefault = setting.default !== undefined && JSON.stringify(value) !== JSON.stringify(setting.default)
  const numberHasContent = setting.type === 'number' && String(value ?? '').trim() !== ''
  // Malformed (not a real number at all) always blocks, regardless of the
  // toggle -- enforceBounds only ever changes whether an in-range check is
  // part of "valid," never whether it parses as a number in the first
  // place. Out-of-range is split into its own case below so the toggle can
  // downgrade JUST that one from a blocking error to a visible warning.
  const numberIsMalformed = numberHasContent && parseNumericSettingValue(value, setting, { enforceBounds: false }) === null
  const numberOutOfRange = numberHasContent && !numberIsMalformed && parseNumericSettingValue(value, setting) === null
  const numberIsInvalid = numberIsMalformed || (numberOutOfRange && !allowOutOfRange)
  const numberIsRangeWarning = numberOutOfRange && !!allowOutOfRange
  // A live value with no matching option -- PZ shipped a value this panel's
  // schema doesn't know (the class of bug the enum audit found: MetaEvent=3
  // when the panel only offered 1-2). The save path never coerces this (see
  // the audit report), so the value itself is safe -- this is purely making
  // that visible instead of rendering a blank Select.
  const hasUnrecognizedValue =
    setting.type === 'select' &&
    !!setting.options &&
    value !== undefined &&
    value !== null &&
    value !== '' &&
    !setting.options.some((o) => o.value === Number(value))

  return (
    <div className={`perf-content-auto grid gap-2 rounded-md border-b py-3 ps-3 pe-4 transition-colors last:border-0 ${
      isModified ? 'bg-warning/5' : 'hover:bg-muted/20'
    }`}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Label className="text-sm font-medium">{getSandboxSettingLabel(setting)}</Label>
            {isModified && (
              <Badge variant="warning" className="h-5 text-xs">{t('row.modifiedBadge')}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">{getSandboxSettingDescription(setting)}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
            <code className="bg-muted px-1 rounded">{setting.key}</code>
            {setting.default !== undefined && (
              <span className={isDifferentFromDefault ? 'text-warning' : ''}>{t('row.defaultValue', { value: formatRawConfigValue(setting.default) })}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isModified && onReset && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-11 w-11 text-warning hover:text-warning sm:h-9 sm:w-9" onClick={() => onReset(setting)} aria-label={t('row.resetAria', { label: getSandboxSettingLabel(setting) })}>
                    <Undo2 className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('row.resetToLoadedValue')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <div className="w-full sm:w-48">
            {setting.type === 'boolean' ? (
              <div className="flex items-center gap-2 justify-end">
                <span className="text-xs text-muted-foreground">{Boolean(value) ? t('row.on') : t('row.off')}</span>
                <Switch
                  checked={Boolean(value)}
                  onCheckedChange={(checked) => onChange(setting, checked)}
                  aria-label={getSandboxSettingLabel(setting) || setting.key}
                />
              </div>
            ) : setting.type === 'select' && setting.options ? (
              <div>
                <Select value={String(value || '')} onValueChange={(v) => onChange(setting, Number(v))}>
                  <SelectTrigger className={hasUnrecognizedValue ? 'border-warning/60' : ''}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {hasUnrecognizedValue && (
                      <SelectItem value={String(value)} disabled>
                        {String(value)} (?)
                      </SelectItem>
                    )}
                    {setting.options.map(opt => (
                      <SelectItem key={opt.value} value={String(opt.value)}>{getSandboxSettingOptionLabel(setting, opt.value)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {hasUnrecognizedValue && (
                  <div className="flex items-start gap-1.5 mt-1.5 text-xs text-warning">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{getUnrecognizedSandboxOptionWarning(String(value))}</span>
                  </div>
                )}
              </div>
            ) : setting.type === 'string' ? (
              // GH#143: a plain text input, no numeric coercion. This used
              // to fall into the numeric branch below (the catch-all had no
              // type === 'string' gate), so every comma the user typed into
              // a comma-separated list (WorldItemRemovalList,
              // LootItemRemovalList -- the only two sandbox settings with
              // type: 'string') got silently turned into a period by
              // normalizeNumericInput(), including on paste. A third string
              // setting added later lands here too rather than silently
              // inheriting the numeric branch.
              <Input
                type="text"
                value={value !== undefined ? String(value) : ''}
                onChange={(e) => onChange(setting, e.target.value)}
                className={isModified ? 'border-warning/40' : ''}
              />
            ) : (
              <div>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={value !== undefined ? String(value) : ''}
                  onChange={(e) => onChange(setting, normalizeNumericInput(e.target.value))}
                  min={setting.min}
                  max={setting.max}
                  step={setting.max && setting.max <= 1 ? 0.1 : 1}
                  aria-invalid={numberIsInvalid}
                  className={`text-end ${isModified ? 'border-warning/40' : ''} ${numberIsInvalid ? 'border-destructive/70' : numberIsRangeWarning ? 'border-warning' : ''}`}
                />
                {(setting.min !== undefined || setting.max !== undefined) && (
                  <div className={`text-xs mt-0.5 flex items-center justify-end gap-1 ${numberIsRangeWarning ? 'text-warning' : 'text-muted-foreground/60'}`}>
                    {numberIsRangeWarning && <AlertTriangle className="h-3 w-3 shrink-0" />}
                    {setting.min !== undefined && setting.max !== undefined
                      ? <bdi>{t('row.rangeMinMax', { min: setting.min, max: setting.max })}</bdi>
                      : setting.min !== undefined
                      ? t('row.rangeMin', { min: setting.min })
                      : t('row.rangeMax', { max: setting.max })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}, (prev, next) => {
  return prev.value === next.value && prev.setting === next.setting && prev.originalValue === next.originalValue && prev.allowOutOfRange === next.allowOutOfRange
})
SandboxSettingRow.displayName = 'SandboxSettingRow'

function StatChip({
  icon,
  value,
  label,
  ok,
}: {
  icon: React.ReactNode
  value: string | number
  label: string
  ok?: boolean
}) {
  const { t } = useTranslation('serverconfig')
  const numericValue = typeof value === 'number' ? value : Number(value)
  const isZero = !Number.isNaN(numericValue) && numericValue === 0
  const muted = isZero || ok === false
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={ok === false ? t('activeServerStrip.fileNotFoundTitle', { label }) : undefined}
    >
      <span className={muted ? 'text-muted-foreground/60' : 'text-primary'} aria-hidden="true">{icon}</span>
      <span className={`font-medium tabular-nums ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>{value}</span>
      <span className="text-muted-foreground">{label}</span>
      {ok === false && (
        <AlertCircle className="h-3 w-3 text-warning" aria-label={t('activeServerStrip.notFoundAria')} />
      )}
    </span>
  )
}

// Icon names used by the INI/Sandbox category schemas, as lucide components.
// The category rail (SubNav) colours them itself: primary when active,
// muted otherwise; shape alone keeps the categories scannable.
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  // INI categories
  Settings,
  Globe,
  Swords,
  MessageSquare,
  Users,
  Home,
  Package,
  Puzzle,
  Cloud,
  Mic,
  MessageCircle,
  Terminal,
  Archive,
  Car,
  Shield,
  Filter,
  Radio,
  FileText,
  Wrench,
  // Sandbox categories
  Clock,
  Gem,
  Heart,
  Crosshair,
  Leaf,
  Map,
  Compass,
  Skull,
  TrendingUp,
  BarChart,
  Layers,
}

function categoryIcon(name?: string): LucideIcon {
  return (name && CATEGORY_ICONS[name]) || Settings
}

const SERVER_CONFIG_TAB_IDS = ['ini', 'sandbox', 'spawnpoints', 'spawnregions', 'modsettings'] as const
type ServerConfigTab = (typeof SERVER_CONFIG_TAB_IDS)[number]
const SERVER_CONFIG_TABS = new Set<string>(SERVER_CONFIG_TAB_IDS)
type ConfigFileType = 'ini' | 'sandbox' | 'spawnpoints' | 'spawnregions'
// The raw editor of each tab; Mod Settings has none, so raw mode there shows the INI.
const RAW_FILE_OF_TAB: Record<ServerConfigTab, ConfigFileType> = {
  ini: 'ini',
  sandbox: 'sandbox',
  spawnpoints: 'spawnpoints',
  spawnregions: 'spawnregions',
  modsettings: 'ini',
}
// Where the config files live in Server Files: the data folder's Server
// subfolder (zomboidDataPath/Server), the panel's default config path.
const SERVER_FILES_CONFIG_LINK = '/files?root=data&path=Server'

// Closed enum matching server/routes/debug.js's triageUnresolvedMods -- an
// unrecognized cause (an older diagnostics fetch predating this, or a value
// this build doesn't know yet) is dropped rather than trusted, same
// defensive stance Debug.tsx takes reading the same querystring value.
// 'panelBridge' is PanelBridge's own Mods= entry, which the panel writes and
// Settings › PanelBridge manages, so it is never offered a typo swap or a
// removal here.
export type UnresolvedModCause = 'typo' | 'stillDownloading' | 'workshopNotOnDisk' | 'absent' | 'panelBridge'
const UNRESOLVED_MOD_CAUSES = new Set<UnresolvedModCause>(['typo', 'stillDownloading', 'workshopNotOnDisk', 'absent', 'panelBridge'])

export function resolveServerConfigDeepLink(searchParams: URLSearchParams) {
  const requestedTab = searchParams.get('tab')
  const unresolved = searchParams.getAll('unresolved')
    .map((modId) => modId.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 20)
  const unresolvedIds = new Set(unresolved)
  // One `modId|cause|suggestion` entry per triaged ID (Debug.tsx's own
  // transport, see getDiagnosticsFixAction's mods.resolved case) -- only
  // trust an entry whose modId is actually in `unresolved` above, so a
  // hand-edited URL can't attach an arbitrary cause to an ID the diagnostics
  // check never flagged.
  // `Map` above 20 lines up is lucide-react's icon component, not the
  // built-in collection -- globalThis.Map dodges that shadowing.
  const unresolvedTriage = new globalThis.Map<string, { cause: UnresolvedModCause; suggestion?: string }>()
  for (const raw of searchParams.getAll('unresolvedCause').slice(0, 20)) {
    const [modId, cause, suggestion] = raw.split('|')
    if (!modId || !unresolvedIds.has(modId)) continue
    if (!UNRESOLVED_MOD_CAUSES.has(cause as UnresolvedModCause)) continue
    unresolvedTriage.set(modId, {
      cause: cause as UnresolvedModCause,
      ...(suggestion ? { suggestion: suggestion.trim().slice(0, 120) } : {}),
    })
  }
  return {
    tab: requestedTab && SERVER_CONFIG_TABS.has(requestedTab) ? requestedTab : 'ini',
    search: (searchParams.get('search') || '').trim().slice(0, 100),
    unresolved,
    unresolvedTriage,
  }
}

export default function ServerConfig() {
  const { t, i18n } = useTranslation('serverconfig')
  const { formatDate, formatDateTime, formatTime } = useDateFormat()
  const searchLocale = i18n.resolvedLanguage || i18n.language
  const [searchParams, setSearchParams] = useSearchParams()
  const initialDeepLink = resolveServerConfigDeepLink(searchParams)
  // List separator is a language property, not something a joined list of
  // translated setting labels can be assumed to want a Latin ", " for --
  // zh-CN / zh-TW enumerates nouns with the ideographic comma instead.
  const listSep = i18n.language.startsWith('zh') ? '、' : ', '
  // The open tab lives in ?tab= (UX plan §2.5): a reload, the command
  // palette and links from other pages (Files, Diagnostics) open it directly.
  const [activeTab, setActiveTabParam] = useUrlParamState<ServerConfigTab>('tab', SERVER_CONFIG_TAB_IDS, 'ini')
  const activeTabRef = useRef<string>(activeTab)
  // On a phone the tab row scrolls sideways; a deep link to a later tab
  // (?tab=spawnregions) must not open with its own tab out of sight.
  const tabListRef = useRef<HTMLDivElement>(null)
  const guardedNavigate = useGuardedNavigate()
  const pendingTabChangeRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const list = tabListRef.current
    const active = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!list || !active || typeof list.scrollBy !== 'function') return
    const box = list.getBoundingClientRect()
    const tab = active.getBoundingClientRect()
    if (tab.left < box.left) list.scrollBy({ left: tab.left - box.left - 8 })
    else if (tab.right > box.right) list.scrollBy({ left: tab.right - box.right + 8 })
  }, [activeTab, loading])
  const [saving, setSaving] = useState(false)
  const [serverRunning, setServerRunning] = useState<boolean | null>(null)
  const [searchQuery, setSearchQuery] = useState(initialDeepLink.search)
  // Defer the search value so each keystroke doesn't re-filter the full schema
  // synchronously — keeps the input snappy on slower machines.
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const [editorMode, setEditorMode] = useState<EditorMode>('structured')
  // Filter mode: 'all' = every schema setting, 'modified' = differs from the PZ default,
  // 'nondefault' = local edits not yet saved.
  const [filterMode, setFilterMode] = useState<FilterMode>(() => {
    if (initialDeepLink.search) return 'all'
    try {
      const stored = localStorage.getItem('serverconfig-filter-mode')
      // Before this migration, "nondefault" represented settings changed from PZ defaults.
      if (stored === 'nondefault') return 'modified'
      if (stored === 'modified' || stored === 'nondefault' || stored === 'all') return stored
    } catch { /* ignore */ }
    return 'all'
  })
  useEffect(() => { try { localStorage.setItem('serverconfig-filter-mode', filterMode) } catch { /* ignore */ } }, [filterMode])

  // File paths info
  const [pathsInfo, setPathsInfo] = useState<{
    configPath: string
    serverName: string
    exists: { ini: boolean; sandbox: boolean; spawnpoints: boolean; spawnregions: boolean }
  } | null>(null)

  // Data states
  const [iniSettings, setIniSettings] = useState<Record<string, string>>({})
  const [sandboxData, setSandboxData] = useState<SandboxData | null>(null)
  const [spawnPoints, setSpawnPoints] = useState<SpawnPointsByProfession>({})
  const [spawnRegions, setSpawnRegions] = useState<SpawnRegion[]>([])
  // The regions as loaded (or last saved): edits to the list are unsaved
  // changes like INI and Sandbox edits, so the SaveBar and the leave-page
  // guard see them.
  const [originalSpawnRegions, setOriginalSpawnRegions] = useState<SpawnRegion[]>([])
  // GET /server-files/ini already detects this server-side (utils/
  // iniDuplicateKeys.js) -- same signal Mods.tsx's own duplicateKeys
  // warning reads from GET /mods/current-config, just never wired up here.
  // parseIni()'s line-by-line loop lets the LAST occurrence win, so
  // iniSettings above silently reflects that one; this state is only for
  // telling the operator the file has more than one candidate value.
  const [duplicateKeys, setDuplicateKeys] = useState<Array<{ key: string; count: number }>>([])

  // Raw content for raw editing mode
  const [rawContent, setRawContent] = useState('')

  // Active category in the vertical rail (one-at-a-time, tab-style)
  const [activeIniCategory, setActiveIniCategory] = useState<string>(() => {
    try { return localStorage.getItem('serverconfig-ini-cat') || 'general' } catch { return 'general' }
  })
  const [activeSandboxCategory, setActiveSandboxCategory] = useState<string>(() => {
    try { return localStorage.getItem('serverconfig-sandbox-cat') || 'time' } catch { return 'time' }
  })
  useEffect(() => { try { localStorage.setItem('serverconfig-ini-cat', activeIniCategory) } catch { /* ignore */ } }, [activeIniCategory])
  useEffect(() => { try { localStorage.setItem('serverconfig-sandbox-cat', activeSandboxCategory) } catch { /* ignore */ } }, [activeSandboxCategory])

  // Backups dialog
  const [showBackups, setShowBackups] = useState(false)
  const [backups, setBackups] = useState<{ filename: string; size: number; created: string }[]>([])
  const [backupFilter, setBackupFilter] = useState<'all' | 'ini' | 'sandbox' | 'spawnpoints' | 'spawnregions'>('all')

  // Templates dialog
  const [showTemplates, setShowTemplates] = useState(false)
  const [templates, setTemplates] = useState<ConfigTemplate[]>([])
  const [templateLoading, setTemplateLoading] = useState(false)
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [newTemplateDesc, setNewTemplateDesc] = useState('')
  const [saveTemplateIni, setSaveTemplateIni] = useState(true)
  const [saveTemplateSandbox, setSaveTemplateSandbox] = useState(true)

  // Track original data for change detection
  const [originalIniSettings, setOriginalIniSettings] = useState<Record<string, string>>({})
  // Keys of originalIniSettings that hold a schema default rather than a
  // value from the file (mergeIniSchemaDefaults); buildIniSavePayload leaves
  // them out of a save unless the operator changed them.
  const [iniDefaultedKeys, setIniDefaultedKeys] = useState<ReadonlySet<string>>(() => new Set())
  // GET /ini's misnamedKeys: keys whose line the game skips ("PVP = true"),
  // each mapped to the option name the game reads there. Their rows say so.
  const [iniMisnamedKeys, setIniMisnamedKeys] = useState<Readonly<Record<string, string>>>({})
  // The value on each of those skipped lines (rawSettings); text rows show it.
  const [iniMisnamedValues, setIniMisnamedValues] = useState<Readonly<Record<string, string>>>({})
  // GET /ini's fatalLines: lines that make the game ignore the whole file
  // ("= x"), so the server runs on every default. A banner names them.
  const [iniFatalLines, setIniFatalLines] = useState<readonly number[]>([])
  // GET /ini's maskedCutAtEqualsKeys: masked secrets the game cuts at an "=".
  const [iniMaskedCutAtEqualsKeys, setIniMaskedCutAtEqualsKeys] = useState<readonly string[]>([])
  // GET /sandbox's parseError: SandboxVars.lua does not parse or has no
  // SandboxVars table, so the form comes back empty and the server refuses
  // structured saves (#197).
  const [sandboxParseError, setSandboxParseError] = useState<string | null>(null)
  // GET /sandbox's worldSandboxSnapshot: the world save has a map_sand.bin,
  // which the game applies over SandboxVars.lua on every start, so edits here
  // are undone at the next restart until it is retired (#197).
  const [worldSandboxSnapshot, setWorldSandboxSnapshot] = useState<WorldSandboxSnapshot | null>(null)
  const [retiringWorldSandboxSnapshot, setRetiringWorldSandboxSnapshot] = useState(false)
  const [originalSandboxData, setOriginalSandboxData] = useState<SandboxData | null>(null)
  const [originalRawContent, setOriginalRawContent] = useState('')

  // Root cause (2026-09-09 dispatch): SANDBOX_SCHEMA's min/max is a
  // build-time snapshot of Project Zomboid's engine-side bounds -- it can
  // never track a PZ patch, only a panel release can, and the game ships no
  // min/max on disk for us to read instead (confirmed: compiled engine-side,
  // only obtainable from a running server). The Mod Settings tab already
  // asks the running game for these same bounds live, every load
  // (PanelBridge.lua's getAllSandboxOptions, opt:getMin()/getMax()) via
  // loadModSettings below -- this just keeps the vanilla groups that call
  // filters OUT for its own UI, keyed the same way SANDBOX_SCHEMA groups its
  // own settings, so the Sandbox tab can prefer a live bound without a
  // second bridge round-trip. Map<`${group}::${shortName}`, {min,max}>;
  // null until a load has been attempted at least once.
  const [sandboxLiveRanges, setSandboxLiveRanges] = useState<Map<string, { min?: number; max?: number }> | null>(null)
  // 'idle' never attempted (bridge tab not yet opened this session) --
  // 'unavailable' means don't block the tab, just show the fallback table
  // and let the user retry; this must never read as "Sandbox tab broken."
  const [sandboxLiveRangesStatus, setSandboxLiveRangesStatus] = useState<'idle' | 'loading' | 'live' | 'unavailable'>('idle')

  // Objective 2 escape hatch (client/src/pages/Settings.tsx's sandboxRangeOverride
  // toggle, plain localStorage -- see getAllowOutOfRangeSandboxValues's own
  // comment for why). Read once at mount; a 'storage' listener picks up a
  // change made in another tab without requiring a remount here. Despite the
  // name it covers the INI tab too since GH#182.
  const [allowOutOfRangeSandbox, setAllowOutOfRangeSandboxState] = useState(() => getAllowOutOfRangeSandboxValues())
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === ALLOW_OUT_OF_RANGE_SANDBOX_STORAGE_KEY || e.key === null) {
        setAllowOutOfRangeSandboxState(getAllowOutOfRangeSandboxValues())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // INI counterpart of invalidSandboxSettings / outOfRangeSandboxSettings
  // below, same blocking-vs-warning split. GH#182: this used to ignore the
  // range override entirely, so an out-of-range VoiceMaxDistance (the panel's
  // table said 1000, the game allows 100000) kept the red banner up and Save
  // disabled with the toggle on. Like the Sandbox list, it describes the
  // structured `iniSettings` state only -- raw-mode edits never touch it, so
  // every consumer scopes it to editorMode === 'structured'.
  const invalidIniSettings = useMemo(
    () => INI_SCHEMA.filter(setting => {
      if (setting.type !== 'number') return false
      const value = iniSettings[setting.key]
      return String(value ?? '').trim() !== '' &&
        parseIniNumber(value, setting, { enforceBounds: !allowOutOfRangeSandbox }) === null
    }),
    [iniSettings, allowOutOfRangeSandbox],
  )

  const outOfRangeIniSettings = useMemo(() => {
    if (!allowOutOfRangeSandbox) return []
    return INI_SCHEMA.filter(setting => {
      if (setting.type !== 'number') return false
      const value = iniSettings[setting.key]
      if (String(value ?? '').trim() === '') return false
      return parseIniNumber(value, setting, { enforceBounds: false }) !== null &&
        parseIniNumber(value, setting) === null
    })
  }, [iniSettings, allowOutOfRangeSandbox])

  // effectiveSandboxSchema overrides SANDBOX_SCHEMA's min/max with the live
  // bridge value wherever one is known, leaving every other field (label,
  // description, default, category...) untouched. Every downstream
  // consumer already expects a plain SandboxSetting[], so this is the one
  // place the live-vs-fallback decision has to be made -- validation,
  // rendering and the save-time sanitizer below all inherit it for free.
  const effectiveSandboxSchema = useMemo<SandboxSetting[]>(() => {
    if (!sandboxLiveRanges || sandboxLiveRanges.size === 0) return SANDBOX_SCHEMA
    return SANDBOX_SCHEMA.map(setting => {
      const group = setting.section && setting.section !== 'settings' ? setting.section : 'Vanilla'
      const live = sandboxLiveRanges.get(`${group}::${setting.key}`)
      if (!live || typeof live.min !== 'number' || typeof live.max !== 'number') return setting
      if (live.min === setting.min && live.max === setting.max) return setting
      return { ...setting, min: live.min, max: live.max }
    })
  }, [sandboxLiveRanges])

  // Blocking set: unparsable numbers always block Save, and so does a
  // genuinely out-of-range number UNLESS the escape hatch is on -- see
  // parseNumericSettingValue's enforceBounds option. Never used to disable
  // the raw-mode Save button (that gate, and the lockout it was fixed for
  // in 547c625a, is handleSaveSandbox's own editorMode==='structured' check
  // below; raw edits never touch `sandboxData`, so this list would never
  // clear for them and must not be read as raw-mode's problem too).
  const invalidSandboxSettings = useMemo(() => {
    if (!sandboxData) return []
    return effectiveSandboxSchema.filter(setting => {
      if (setting.type !== 'number') return false
      const section = (setting.section || 'settings') as keyof SandboxData
      const value = (sandboxData[section] as SandboxRecord | undefined)?.[setting.key]
      if (value === undefined || value === null || String(value).trim() === '') return false
      return parseNumericSettingValue(value, setting, { enforceBounds: !allowOutOfRangeSandbox }) === null
    })
  }, [sandboxData, effectiveSandboxSchema, allowOutOfRangeSandbox])

  // Warning-only set: a real, parsable number that's outside the known
  // range but ISN'T in invalidSandboxSettings above because the escape
  // hatch let it through. Empty whenever the toggle is off, by construction
  // (every out-of-range value is still in invalidSandboxSettings then) --
  // only meaningful, and only rendered, alongside the toggle being on.
  const outOfRangeSandboxSettings = useMemo(() => {
    if (!sandboxData || !allowOutOfRangeSandbox) return []
    return effectiveSandboxSchema.filter(setting => {
      if (setting.type !== 'number') return false
      const section = (setting.section || 'settings') as keyof SandboxData
      const value = (sandboxData[section] as SandboxRecord | undefined)?.[setting.key]
      if (value === undefined || value === null || String(value).trim() === '') return false
      const parsesAtAll = parseNumericSettingValue(value, setting, { enforceBounds: false }) !== null
      const withinBounds = parseNumericSettingValue(value, setting, { enforceBounds: true }) !== null
      return parsesAtAll && !withinBounds
    })
  }, [sandboxData, effectiveSandboxSchema, allowOutOfRangeSandbox])

  // Mod Settings (live from PanelBridge)
  const [modSettings, setModSettings] = useState<Record<string, Array<{
    name?: string; shortName?: string; tableName?: string; value?: unknown;
    type?: string; min?: number; max?: number; default?: unknown;
    enumValues?: string[]; selectedIndex?: number; translatedName?: string;
    tooltip?: string; tooltipText?: string; pageName?: string;
  }>> | null>(null)
  const [modSettingsGroups, setModSettingsGroups] = useState<Array<{ name: string; count: number }>>([])
  const [modSettingsLoading, setModSettingsLoading] = useState(false)
  const [modSettingsError, setModSettingsError] = useState<string | null>(null)
  const [modSettingsSearch, setModSettingsSearch] = useState('')
  const [modSettingsModifiedOnly, setModSettingsModifiedOnly] = useState(false)
  const [expandedModGroups, setExpandedModGroups] = useState<Set<string>>(new Set())
  const [modSettingsLastLoaded, setModSettingsLastLoaded] = useState<Date | null>(null)
  // Generation counter, not an AbortController -- panelBridgeApi.sendCommand
  // has no signal option to cancel the in-flight request, so the previous
  // AbortController here aborted nothing and its signal was never even
  // passed to sendCommand. Two Refresh clicks close together used to race:
  // whichever response landed last (not last-requested) won, silently.
  const modSettingsLoadIdRef = useRef(0)
  const [savingOptions, setSavingOptions] = useState<Set<string>>(new Set())

  // Shared helper: is this mod option modified from its default?
  const isOptModified = useCallback((opt: { default?: unknown; value?: unknown }) => {
    if (opt.default === undefined || opt.default === null) return false
    const d = opt.default, v = opt.value
    if (typeof d === 'number' && typeof v === 'number') return Math.abs(d - v) >= 0.0001
    return String(d) !== String(v)
  }, [])

  // Total count of modified mod options across all groups
  const modifiedModSettingsCount = useMemo(() => {
    if (!modSettings) return 0
    let c = 0
    for (const opts of Object.values(modSettings)) {
      for (const o of opts) if (isOptModified(o)) c++
    }
    return c
  }, [modSettings, isOptModified])

  // Any enum whose last value the running PanelBridge can't save means the
  // server still runs the old Lua: one callout for the tab, not one per row.
  const modSettingsBridgeOutdated = useMemo(() => {
    if (!modSettings) return false
    return Object.values(modSettings).some(opts => opts.some(o => describeModEnumControl(o)?.blockedValue != null))
  }, [modSettings])

  // Memoize filtered mod settings groups to avoid duplicate filter logic
  const filteredModGroups = useMemo(() => {
    if (!modSettings || !modSettingsGroups.length) return []
    const q = modSettingsSearch.toLowerCase().trim()
    return modSettingsGroups
      .map(group => {
        let opts = modSettings[group.name] || []
        if (modSettingsModifiedOnly) opts = opts.filter(isOptModified)
        if (q) {
          const groupMatches = formatModSettingLabel(group.name).toLowerCase().includes(q)
          if (!groupMatches) {
            opts = opts.filter(o =>
              (o.name || '').toLowerCase().includes(q) ||
              (o.shortName || '').toLowerCase().includes(q) ||
              (o.translatedName || '').toLowerCase().includes(q) ||
              formatModSettingLabel(o.translatedName || o.shortName || o.name, group.name).toLowerCase().includes(q) ||
              (o.tooltip || '').toLowerCase().includes(q) ||
              (o.tooltipText || '').toLowerCase().includes(q)
            )
          }
        }
        return { ...group, filteredOpts: opts }
      })
      .filter(g => g.filteredOpts.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [modSettings, modSettingsGroups, modSettingsSearch, modSettingsModifiedOnly, isOptModified])

  // Copy state
  const [copied, setCopied] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Active server context, read independently of the (possibly-failed) paths
  // load below -- server/routes/serverFiles.js's getServerConfigPath() falls
  // through a remote server with no SFTP transport configured to the same
  // ServerNotConfiguredError a genuinely-unconfigured panel throws, so the
  // wire error code alone can't tell "no active server" apart from "active
  // server is remote and isn't set up for config editing". Same
  // isRemote-flag-fetched-independently pattern as Backups.tsx.
  const [activeServerRemote, setActiveServerRemote] = useState(false)
  const [activeServerName, setActiveServerName] = useState<string | null>(null)
  // How PanelBridge reaches the active server, only to word the
  // DoLuaChecksum callout (§4.12). undefined while GET /panel-bridge/delivery
  // hasn't answered (no callout yet: guessing Local would flash the
  // destructive alert on a confirmed Workshop server), null once it failed
  // -- which reads as panel-installed, the delivery that can only ever warn
  // more, never less. See resolveLuaChecksumCallout.
  const [bridgeDelivery, setBridgeDelivery] = useState<LuaChecksumDelivery | null | undefined>(undefined)
  const bridgeDeliveryGuard = useRequestGuard()
  // Set when activeServerChanged fires while this page has unsaved edits --
  // GET/PUT /server-files/ini and /sandbox both resolve "the active server"
  // fresh on the server per-request rather than taking a server id, so
  // Save always writes to whichever server is active NOW, not whichever
  // server's data is actually sitting in iniSettings/sandboxData. Loading
  // fresh data on every activeServerChanged (like Settings.tsx does) would
  // silently discard those edits instead; this blocks Save until the user
  // explicitly reloads, so the choice to lose the edit is theirs, not a
  // race between two browser tabs.
  const [serverChangedSinceLoad, setServerChangedSinceLoad] = useState(false)

  // File browser state (for image path fields)
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false)
  const [fileBrowserKey, setFileBrowserKey] = useState('')  // which INI key we're picking a file for
  const [fileBrowserPath, setFileBrowserPath] = useState('')
  const [fileBrowserDirs, setFileBrowserDirs] = useState<string[]>([])
  const [fileBrowserFiles, setFileBrowserFiles] = useState<{ name: string; ext: string }[]>([])
  const [fileBrowserParent, setFileBrowserParent] = useState<string | null>(null)
  const [fileBrowserLoading, setFileBrowserLoading] = useState(false)
  const [fileBrowserExtensions, setFileBrowserExtensions] = useState<string[]>([])
  const [fileBrowserSelected, setFileBrowserSelected] = useState<string | null>(null)

  const { toast } = useToast()
  const confirm = useConfirm()
  const socket = useSocket()
  const { can } = useAuth()
  // Whole-router gate on the server: server/routes/serverFiles.js applies
  // requirePermission("serverfiles.manage") to every route in the file, GET
  // included -- there's no partial-access tier, so a page-level gate here is
  // the correct grain, not a compromise (Settings.tsx's precedent gates
  // whole TABS the same way, because that's the grain ITS capabilities come
  // in). can() fails OPEN when capabilities are unknown/null -- see
  // AuthContext's own doc comment -- so this only ever hides the page when
  // the answer is a confirmed no, never while unsure.
  const canManageServerFiles = can('serverfiles.manage')

  // Load initial data
  useEffect(() => {
    if (canManageServerFiles) loadData()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- intentional mount-only init

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current)
      }
    }
  }, [])

  // Fire-and-forget beside loadData, never inside its sequential chain: a
  // slow or refused delivery status must not delay or fail the config load.
  // GET /panel-bridge/delivery accepts serverfiles.manage, this page's gate.
  // loadData runs again on activeServerChanged and after every save, so a
  // slow answer for the previous server must not land after the new one
  // (same race as the round-9 sweep), and the previous server's method is
  // dropped while the new answer is pending -- the page is behind its
  // loading skeleton for most of that anyway.
  const loadBridgeDelivery = async () => {
    const requestId = bridgeDeliveryGuard.next()
    setBridgeDelivery(undefined)
    try {
      const status: unknown = await panelBridgeApi.getDelivery()
      if (bridgeDeliveryGuard.isStale(requestId)) return
      // An answer that isn't a DeliveryStatus (the demo build's catch-all)
      // counts as a failed call: the local fallback below.
      setBridgeDelivery(
        isDeliveryStatus(status)
          ? { method: status.method, state: status.state, turnOnBlockers: status.checksum.turnOnBlockers }
          : null,
      )
    } catch {
      if (bridgeDeliveryGuard.isStale(requestId)) return
      setBridgeDelivery(null)
    }
  }

  // A GET /server-files/ini answer into the INI form's state: on load, and
  // again after a structured save.
  const applyIniData = (iniData: Awaited<ReturnType<typeof serverFilesApi.getIni>>) => {
    // rawSettings: each value as the game reads it (see iniFormState.ts).
    const fileSettings = iniData.rawSettings ?? iniData.settings
    const misnamedKeys = iniData.misnamedKeys ?? {}
    const loaded = mergeIniSchemaDefaults(fileSettings, misnamedKeys)
    setIniSettings(loaded.settings)
    setOriginalIniSettings(loaded.settings)
    setIniDefaultedKeys(loaded.defaultedKeys)
    setIniMisnamedKeys(misnamedKeys)
    setIniMisnamedValues(Object.fromEntries(Object.keys(misnamedKeys).map((key) => [key, fileSettings[key] ?? ''])))
    setIniFatalLines(iniData.fatalLines ?? [])
    setIniMaskedCutAtEqualsKeys(iniData.maskedCutAtEqualsKeys ?? [])
    setDuplicateKeys(iniData.duplicateKeys || [])
  }

  // The INI form's state for a server with no server.ini (never started): the
  // same empty state a fresh mount shows. loadData() calls this so a switch
  // from a server that had one doesn't leave that server's values on screen.
  const clearIniData = () => {
    setIniSettings({})
    setOriginalIniSettings({})
    setIniDefaultedKeys(new Set())
    setIniMisnamedKeys({})
    setIniMisnamedValues({})
    setIniFatalLines([])
    setIniMaskedCutAtEqualsKeys([])
    setDuplicateKeys([])
  }

  // 2026-09-08 (retry-stacking sweep, page 5 of 5): `manual` distinguishes
  // this page's THREE human-initiated triggers (two Retry buttons on the
  // error/server-changed banners, plus the page header's own Refresh
  // button) from the mount effect -- see Servers.tsx's fetchServers() for
  // the full reasoning. Sequential awaits, not Promise.all/allSettled --
  // the first one to reject short-circuits the rest, so a persistent
  // getPaths() failure alone is what the mount-vs-manual test can rely on.
  const loadData = async (opts?: { manual?: boolean }) => {
    const retries = opts?.manual ? { retries: 0 } : undefined
    setLoading(true)
    void loadBridgeDelivery()
    setServerChangedSinceLoad(false)
    const active = await serversApi.getResolvedActive().catch(() => ({ server: null }))
    const isRemote = !!active.server?.isRemote
    setActiveServerRemote(isRemote)
    setActiveServerName(active.server?.name || active.server?.serverName || null)
    try {
      // Load paths info first
      const paths = await serverFilesApi.getPaths(retries)
      setPathsInfo(paths)

      // Load files that exist
      // A file that is missing on THIS server must clear what the previous
      // server left in its state (this runs again on a server switch): the
      // forms would otherwise show server A's values, and saving spawn
      // points or regions would write A's data into B.
      if (paths.exists.ini) {
        applyIniData(await serverFilesApi.getIni(retries))
      } else {
        clearIniData()
      }

      const sandboxRes = paths.exists.sandbox
        ? await serverFilesApi.getSandbox(retries)
        : { sandbox: createSandboxDefaults() }
      setSandboxData(sandboxRes.sandbox)
      setOriginalSandboxData(sandboxRes.sandbox)
      setSandboxParseError(('parseError' in sandboxRes && sandboxRes.parseError?.message) || null)
      setWorldSandboxSnapshot(('worldSandboxSnapshot' in sandboxRes && sandboxRes.worldSandboxSnapshot) || null)

      if (paths.exists.spawnpoints) {
        const spawnRes = await serverFilesApi.getSpawnPoints(retries)
        setSpawnPoints(spawnRes.spawnpoints)
      } else {
        setSpawnPoints({})
      }

      if (paths.exists.spawnregions) {
        const regionsRes = await serverFilesApi.getSpawnRegions(retries)
        setSpawnRegions(regionsRes.spawnregions)
        setOriginalSpawnRegions(regionsRes.spawnregions)
      } else {
        setSpawnRegions([])
        setOriginalSpawnRegions([])
      }
      setLoadError(null)
    } catch (error) {
      reportClientError('Failed to load config.', error)
      // getServerConfigPath() (server/routes/serverFiles.js) throws the same
      // "no active server" error for a genuinely-unconfigured panel AND for
      // a remote server with no SFTP transport set up -- the wire code can't
      // be trusted to tell those apart here. When we independently know the
      // active server IS set and IS remote, say that instead of repeating
      // the server's misleading "no active server" text: reuse the exact
      // copy errors.json already ships for this condition everywhere else
      // remote config access is gated (server/routes/serverFiles.js's own
      // second-stage SFTP-transport gate), rather than inventing new copy.
      const message = isRemote
        ? i18n.t('REMOTE_CONFIG_NOT_CONFIGURED', { ns: 'errors' })
        : getUserErrorMessage(error, t('toasts.loadConfigFailed'))
      setLoadError(message)
      // The remote case renders as a persistent warning banner below (no
      // Retry button -- this is a setup step, not a failure), deliberately
      // not the destructive framing a toast titled "Error" would give it.
      // Firing that toast anyway said the opposite of what the banner right
      // under it says, and duplicated the same sentence a second time on
      // screen for a standing fact that isn't going away on its own, unlike
      // a genuine one-off fetch failure below, which still gets the toast.
      if (!isRemote) {
        toast({
          title: t('toasts.error'),
          description: message,
          variant: 'destructive'
        })
      }
    } finally {
      setLoading(false)
    }
  }

  // GH#118-adjacent (2026-08-26, "the sibling that was never hardened"):
  // serverApi.getStatus() is the raw local process scan -- correct for a
  // native server, but blind to a docker-managed server's process, which
  // runs in a different container this scan can never see (same root cause
  // as GH#114). Trusting it unconditionally here meant a live docker
  // container could read serverRunning=false, which suppresses BOTH the
  // "stop the server before editing" banner and the sticky-bar Discard
  // guard below. resolveServerRunning() (client/src/lib/serverStatus.ts)
  // shares resolveClientProvider() and the same 3-signal composed-status
  // read Layout.tsx/Dashboard.tsx already use (54cf13a/2d5745e), rather
  // than re-deriving a fourth implementation of the same idea -- see that
  // function's own doc comment for the fail-closed contract it guarantees.
  const refreshServerState = useCallback(async () => {
    try {
      const { server } = await serversApi.getActive()
      const running = await resolveServerRunning(server, serverApi.getStatus, serversApi.getComposedStatus)
      setServerRunning(running)
    } catch {
      setServerRunning(null)
    }
  }, [])

  // Only a CONFIRMED-stopped server (serverRunning === false) is safe to
  // let through unwarned. true (confirmed running) and null (unknown --
  // lookup failed, no active server, or an indeterminate composed signal)
  // both must behave as "it might be running": unknown is the safe answer
  // here, never the permissive one.
  const serverMayBeRunning = serverRunning !== false
  // Retiring map_sand.bin (#197) waits for a stopped server. A remote
  // server's process is out of this panel's sight, so it never reads as
  // confirmed stopped: there the action waits only while RCON or the bridge
  // shows it running (the server refuses while RCON is connected).
  const worldSandboxSnapshotRetireBlocked = activeServerRemote ? serverRunning === true : serverMayBeRunning

  useEffect(() => {
    void refreshServerState()
    const interval = setInterval(() => { void refreshServerState() }, 5000)
    return () => clearInterval(interval)
  }, [refreshServerState])

  // Track if raw content is loading
  const [_loadingRaw, setLoadingRaw] = useState(false)

  // Load raw content when switching to raw mode
  const loadRawContent = async (type: 'ini' | 'sandbox' | 'spawnpoints' | 'spawnregions') => {
    setLoadingRaw(true)
    try {
      const data = await serverFilesApi.getRaw(type)
      setRawContent(data.content)
      setOriginalRawContent(data.content)
      if (type === 'sandbox') setWorldSandboxSnapshot(data.worldSandboxSnapshot ?? null)
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.loadRawFailed')),
        variant: 'destructive'
      })
      // Reset to structured mode on error
      setEditorMode('structured')
    } finally {
      setLoadingRaw(false)
    }
  }

  const luaChecksumCallout = resolveLuaChecksumCallout(bridgeDelivery, iniSettings['DoLuaChecksum'])

  // The server.ini lines that make the game ignore the whole file: GET
  // /ini's fatalLines, or, while the INI tab's raw editor is open, the text
  // being edited, read the same way as the operator types.
  const shownIniFatalLines = useMemo(
    () => (activeTab === 'ini' && editorMode === 'raw' ? findIniFatalLines(rawContent) : iniFatalLines),
    [activeTab, editorMode, rawContent, iniFatalLines],
  )

  // Check for unsaved changes
  const hasIniChanges = useMemo(() => {
    if (editorMode === 'raw' && activeTab === 'ini') {
      return rawContent !== originalRawContent
    }
    return JSON.stringify(iniSettings) !== JSON.stringify(originalIniSettings)
  }, [editorMode, activeTab, rawContent, originalRawContent, iniSettings, originalIniSettings])

  const hasSandboxChanges = useMemo(() => {
    if (editorMode === 'raw' && activeTab === 'sandbox') {
      return rawContent !== originalRawContent
    }
    return JSON.stringify(sandboxData) !== JSON.stringify(originalSandboxData)
  }, [editorMode, activeTab, rawContent, originalRawContent, sandboxData, originalSandboxData])

  // Spawn Regions and Spawn Points join the same dirty tracking: an edited
  // region list (or raw file) used to be dropped without a word by a server
  // switch or a sidebar click.
  const hasSpawnRegionChanges = useMemo(() => {
    if (editorMode === 'raw' && activeTab === 'spawnregions') {
      return rawContent !== originalRawContent
    }
    return JSON.stringify(spawnRegions) !== JSON.stringify(originalSpawnRegions)
  }, [editorMode, activeTab, rawContent, originalRawContent, spawnRegions, originalSpawnRegions])
  // Spawn points have no form editor (they are mod-managed): only the raw file.
  const hasSpawnPointChanges = editorMode === 'raw' && activeTab === 'spawnpoints' && rawContent !== originalRawContent

  // Unsaved edits in the raw textarea, whichever file it shows. The Raw
  // buttons and a tab change in raw mode all reload the textarea from disk
  // (loadRawContent), so they ask before replacing such edits.
  const hasRawEdits = editorMode === 'raw' && rawContent !== originalRawContent
  // Unsaved changes in the Form of the tab on screen: the raw editor shows
  // the file as it is on disk, without them.
  const hasFormEdits = editorMode === 'structured'
    && ((activeTab === 'ini' && hasIniChanges) || (activeTab === 'sandbox' && hasSandboxChanges))
  const hasUnsavedChanges = hasIniChanges || hasSandboxChanges || hasSpawnRegionChanges || hasSpawnPointChanges || hasRawEdits
  // Every unsaved edit on the page, whichever tab holds it: leaving through
  // the sidebar, a link, the palette or a shortcut asks first, and closing
  // or reloading the tab gets the browser's prompt (the SaveBar below only
  // covers the tab on screen).
  useUnsavedChangesGuard(hasUnsavedChanges)

  const confirmDiscardRawEdits = () => confirm({
    title: t('switchEditorConfirm.rawTitle'),
    description: t('switchEditorConfirm.rawDescription'),
    confirmLabel: t('switchEditorConfirm.rawConfirm'),
    destructive: true,
  })

  const showRawEditor = (type: ConfigFileType) => {
    setEditorMode('raw')
    void loadRawContent(type)
  }

  // Form button: leaving the raw editor drops what was typed there.
  const openFormEditor = () => {
    if (!hasRawEdits) {
      setEditorMode('structured')
      return
    }
    void confirmDiscardRawEdits().then((ok) => { if (ok) setEditorMode('structured') })
  }

  // Raw button: loads the file from disk into the textarea. Pressed while the
  // raw editor is already open it reloads, which drops the edits in it too.
  const openRawEditor = (type: ConfigFileType) => {
    if (hasRawEdits) {
      void confirmDiscardRawEdits().then((ok) => { if (ok) showRawEditor(type) })
    } else if (hasFormEdits) {
      void confirm({
        title: t('switchEditorConfirm.formTitle'),
        description: t('switchEditorConfirm.formDescription'),
        confirmLabel: t('switchEditorConfirm.formConfirm'),
        variant: 'warning',
      }).then((ok) => { if (ok) showRawEditor(type) })
    } else {
      showRawEditor(type)
    }
  }

  const handleTabChange = (value: string) => {
    if (!SERVER_CONFIG_TABS.has(value)) return
    if (value === activeTabRef.current || pendingTabChangeRef.current !== null) return
    const tab = value as ServerConfigTab

    const switchTab = () => {
      activeTabRef.current = tab
      pendingTabChangeRef.current = null
      setActiveTabParam(tab)
      if (editorMode === 'raw') {
        void loadRawContent(RAW_FILE_OF_TAB[tab])
      }
    }
    if (!hasRawEdits) {
      switchTab()
      return
    }
    pendingTabChangeRef.current = tab
    void confirmDiscardRawEdits().then((ok) => {
      if (ok) switchTab()
      else if (pendingTabChangeRef.current === tab) pendingTabChangeRef.current = null
    })
  }

  // ?tab= changed without the tab strip (a command-palette deep link while
  // the page is open): the raw editor follows it like a click would.
  useEffect(() => {
    if (activeTabRef.current === activeTab) return
    activeTabRef.current = activeTab
    if (editorMode === 'raw') void loadRawContent(RAW_FILE_OF_TAB[activeTab])
  }, [activeTab]) // eslint-disable-line react-hooks/exhaustive-deps -- only a tab change outside handleTabChange reloads

  // GET/PUT /server-files/ini and /sandbox both resolve "the active server"
  // fresh per-request rather than taking a server id (see loadData() and
  // handleSaveIni/handleSaveSandbox), so if the active server changes while
  // this page is open, Save would silently write the loaded server's data
  // onto whichever server is active now. With no unsaved edits it's safe to
  // just reload, matching every other page's activeServerChanged handler
  // (Settings.tsx, Dashboard.tsx, Servers.tsx, WorldMap.tsx, Layout.tsx);
  // with unsaved edits, reloading would silently discard them instead, so
  // this blocks Save and surfaces a banner instead of choosing for the user.
  useEffect(() => {
    if (!socket) return
    const handleActiveServerChanged = () => {
      if (hasUnsavedChanges) {
        setServerChangedSinceLoad(true)
      } else {
        loadData()
      }
    }
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, hasUnsavedChanges]) // eslint-disable-line react-hooks/exhaustive-deps -- loadData is mount-stable, not a dep

  // Create manual backup
  const handleCreateBackup = async (type: 'ini' | 'sandbox' | 'spawnpoints' | 'spawnregions') => {
    try {
      const data = await serverFilesApi.getRaw(type)
      const blob = new Blob([data.content], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${data.filename}_${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
      a.click()
      URL.revokeObjectURL(url)
      toast({ title: t('toasts.downloadedTitle'), description: t('toasts.backupSavedDesc', { filename: data.filename }) })
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.downloadBackupFailed')),
        variant: 'destructive'
      })
    }
  }

  // Copy raw content to clipboard
  const handleCopyRaw = async () => {
    try {
      await copyText(rawContent)
      setCopied(true)
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current)
      }
      copiedTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
      toast({ title: t('toasts.copiedTitle'), description: t('toasts.copiedDesc') })
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.copyFailed')),
        variant: 'destructive'
      })
    }
  }

  // Save handlers

  // Load mod sandbox options from PanelBridge
  const loadModSettings = useCallback(async () => {
    const loadId = ++modSettingsLoadIdRef.current
    setModSettingsLoading(true)
    setModSettingsError(null)
    setSandboxLiveRangesStatus('loading')
    try {
      // getAllSandboxOptions enumerates every sandbox option server-wide
      // (vanilla + every mod's contributed settings) with no chunking on the
      // mod side, and its cache goes cold on restart, on any admin sandbox
      // change, or after any 5-minute idle gap -- so a cold run on a
      // heavily-modded server can legitimately take longer than a generic
      // API call. Use the slow-enumeration timeout (comfortably above the
      // server's own worst-case commandTimeoutMs, see api.ts) so that if the
      // bridge genuinely can't answer in time, the SERVER's own honest
      // timeout response wins the race and reaches the user here -- instead
      // of our own client abort firing first with a generic, misleading
      // "check your connection".
      const response = await panelBridgeApi.sendCommand('getAllSandboxOptions', {}, { timeout: BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS }) as {
        success?: boolean
        data?: {
          options: Record<string, Array<{
            name?: string; shortName?: string; tableName?: string; value?: unknown;
            type?: string; min?: number; max?: number; default?: unknown;
            enumValues?: string[]; selectedIndex?: number; translatedName?: string;
            tooltip?: string; tooltipText?: string; pageName?: string;
          }>>
          groups: Array<{ name: string; count: number }>
          totalCount: number
          enumerated: boolean
        }
        error?: string
      }
      if (modSettingsLoadIdRef.current !== loadId) return
      if (response?.success && response.data) {
        const options = Object.fromEntries(
          Object.entries(response.data.options).filter(([groupName]) => !VANILLA_SANDBOX_GROUPS.has(groupName))
        )
        const groups = response.data.groups.filter(group => !VANILLA_SANDBOX_GROUPS.has(group.name))
        setModSettings(options)
        setModSettingsGroups(groups)
        setModSettingsLastLoaded(new Date())
        setModSettingsError(null)

        // Sandbox tab's live-range fix: this same response already carries
        // the vanilla groups the filter above throws away for Mod
        // Settings' own UI -- keep them here, keyed the same way
        // SANDBOX_SCHEMA groups its own settings (`section`, or "Vanilla"
        // for a setting with no section), so effectiveSandboxSchema can
        // look one up without a second bridge round-trip.
        // `Map` in this file is lucide-react's icon component (see the
        // Vehicles/Spawn Regions tab icons above) -- globalThis.Map dodges
        // that shadowing, same as the unresolvedTriage Map elsewhere in
        // this file.
        const liveRanges = new globalThis.Map<string, { min?: number; max?: number }>()
        for (const [groupName, opts] of Object.entries(response.data.options)) {
          if (!VANILLA_SANDBOX_GROUPS.has(groupName)) continue
          for (const opt of opts) {
            if (!opt.shortName || typeof opt.min !== 'number' || typeof opt.max !== 'number') continue
            liveRanges.set(`${groupName}::${opt.shortName}`, { min: opt.min, max: opt.max })
          }
        }
        setSandboxLiveRanges(liveRanges)
        setSandboxLiveRangesStatus('live')
      } else {
        setModSettingsError(response?.error || t('modSettingsTab.loadFailedNotConnected'))
        setSandboxLiveRangesStatus('unavailable')
      }
    } catch (error) {
      if (modSettingsLoadIdRef.current !== loadId) return
      setModSettingsError(getUserErrorMessage(error, t('modSettingsTab.loadFailedCheckConnection')))
      setSandboxLiveRangesStatus('unavailable')
    } finally {
      if (modSettingsLoadIdRef.current === loadId) setModSettingsLoading(false)
    }
  }, [t])

  // Auto-load mod settings the first time the user opens the tab.
  // After an error, we don't auto-retry — the user can click "Retry".
  useEffect(() => {
    if (activeTab === 'modsettings' && !modSettings && !modSettingsLoading && !modSettingsError) {
      loadModSettings()
    }
  }, [activeTab, modSettings, modSettingsLoading, modSettingsError, loadModSettings])

  // Same bridge call, same cache, triggered from the Sandbox tab instead --
  // whichever tab is opened first populates both modSettings and
  // sandboxLiveRanges, so opening the other tab afterward never re-fetches.
  // 'idle' only fires once per session per the same no-auto-retry-after-
  // failure rule as the effect above (checked via status, not modSettings/
  // modSettingsError, since a failure here also sets those and must not
  // make the *other* tab's own auto-load re-fire either -- one failed
  // enumeration is one failed enumeration, not two).
  useEffect(() => {
    if (activeTab === 'sandbox' && sandboxLiveRangesStatus === 'idle') {
      loadModSettings()
    }
  }, [activeTab, sandboxLiveRangesStatus, loadModSettings])

  const handleOptionChange = useCallback(async (optName: string, newValue: unknown, groupName: string) => {
    // continuous-bug-hunt round 17 (every write that trusts the server-side
    // active server): setSandboxOption/saveSandboxOption below both resolve
    // "the active server" server-side with no server id -- same shape as
    // handleSaveIni/handleSaveSandbox's own serverChangedSinceLoad guard,
    // just reached from the "Active" tab's per-option controls instead of a
    // single Save button. Unlike those two, this fires per click with no
    // dirty-tracking of its own, so the guard has to sit right here.
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.error'),
        description: t('toasts.serverChangedSinceLoad'),
        variant: 'destructive',
      })
      return
    }
    // Prevent duplicate inflight requests for the same option
    setSavingOptions(prev => {
      if (prev.has(optName)) return prev
      const next = new Set(prev)
      next.add(optName)
      return next
    })
    try {
      const response = await panelBridgeApi.sendCommand('setSandboxOption', { name: optName, value: newValue }) as {
        success?: boolean
        data?: { name: string; value: unknown; type: string; verified?: unknown; persisted?: unknown; saveError?: unknown }
        error?: string
        worldSandboxSnapshot?: LiveWorldSandboxSnapshot
      }
      if (response?.success && response.data) {
        const confirmedVal = response.data.value ?? newValue
        setModSettings(prev => {
          if (!prev) return prev
          const updated = { ...prev }
          const groupOpts = updated[groupName]
          if (groupOpts) {
            updated[groupName] = groupOpts.map(o => {
              if (o.name !== optName) return o
              const patched = { ...o, value: confirmedVal }
              // Sync selectedIndex for enums so the dropdown reflects the new value
              if (o.type === 'enum' && typeof confirmedVal === 'number') {
                patched.selectedIndex = confirmedVal
              }
              return patched
            })
          }
          return updated
        })
        // setSandboxOption's Lua handler reports this under `verified` as of
        // the matched->verified rename (2026-08-23, same pass as the shared
        // verify-gating helper) -- a mod still running the pre-rename build
        // reports the identical check under `matched` instead, which reads
        // here as 'old-bridge' (no `verified` key) until the operator
        // updates. That's the correct signal either way: an un-migrated mod
        // genuinely IS an old bridge relative to this contract.
        const verifyState = getBridgeVerifiedState('setSandboxOption', response.data)
        // #197: on a world with a map_sand.bin (loaded over SandboxVars.lua
        // on every start) the edit lasts only if the bridge rewrote that
        // file too, which the server asked it to.
        const worldSandbox = liveWorldSandboxOutcome(response)
        toast(
          verifyState === 'unverifiable'
            ? { title: t('toasts.optionUpdatedTitle'), description: t('toasts.bridgeUnverifiedDesc', { action: optName }), variant: 'default' }
            : verifyState === 'old-bridge'
              ? { title: t('toasts.optionUpdatedTitle'), description: t('toasts.bridgeOldBridgeDesc', { action: optName }), variant: 'default' }
              : worldSandbox === 'kept'
                ? { title: t('toasts.optionUpdatedTitle'), description: t('toasts.optionKeptInWorldDesc', { option: optName }) }
                : { title: t('toasts.optionUpdatedTitle'), description: t('toasts.optionUpdatedDesc', { option: optName }) },
        )

        if (worldSandbox === 'undone') {
          toast({
            title: t('toasts.appliedNotSavedTitle'),
            description: t('toasts.worldSandboxNotKeptDesc', { option: optName }),
            variant: 'destructive',
          })
        } else if (!worldSandbox && isWorldSaveFailure(response.data)) {
          // Only an older bridge reports a world save; see
          // isWorldSaveFailure()'s own comment for the persisted/saveError
          // contract. That save is a DIFFERENT persistence layer from the
          // SandboxVars.lua file write checked just below, so each can fail
          // on its own. On a world that had a map_sand.bin it is the one
          // worldSandbox above already reports.
          toast({
            title: t('toasts.appliedNotSavedTitle'),
            description: t('toasts.worldSaveFailedDesc', {
              option: optName,
              reason: typeof response.data.saveError === 'string' ? response.data.saveError : t('toasts.unknownError'),
            }),
            variant: 'destructive',
          })
        }

        // The bridge only changes the live value. Without this the option
        // reverts to whatever SandboxVars.lua still says on the next restart.
        try {
          const saved = await serverFilesApi.saveSandboxOption(
            optName,
            confirmedVal as string | number | boolean,
          )
          // A bridge older than #197 has just written map_sand.bin for this
          // edit; the reply says whether the world has one now.
          setWorldSandboxSnapshot(saved.worldSandboxSnapshot ?? null)
          // Kept in the world's map_sand.bin, the edit survives the next
          // start whatever SandboxVars.lua says.
          if (!saved.persisted && worldSandbox !== 'kept') {
            toast({
              title: t('toasts.appliedNotSavedTitle'),
              description: t('toasts.notPersistedDesc', { option: optName }),
              variant: 'destructive',
            })
          }
        } catch (error) {
          // PUT /sandbox-option used to be gated behind "stop the server
          // first" (LOCAL_CONFIG_MUTATIONS in serverFiles.js), and since the
          // live edit above only ever succeeds while the server IS running,
          // this persistence attempt was guaranteed to 409 on every single
          // edit -- with getUserErrorMessage resolving that SERVER_RUNNING
          // code to "Stop the server before editing configuration" before it
          // ever looked at our fallback, actively bad advice since stopping
          // the server only locked the operator out of this tab. Measured
          // 2026-08-23 that a clean shutdown never rewrites this file at all,
          // so that gate was removed for this one route (server/routes/
          // serverFiles.js's LOCAL_CONFIG_MUTATIONS comment has the evidence)
          // and this call should no longer 409 in normal operation. Kept as
          // a defensive fallback in case SERVER_RUNNING is ever reached here
          // some other way -- still shows the accurate message instead of
          // letting the generic code lookup bury it.
          const isServerRunningRefusal = error instanceof ApiError && error.code === 'SERVER_RUNNING'
          toast({
            title: t('toasts.appliedNotSavedTitle'),
            description: isServerRunningRefusal
              ? t('toasts.willResetFallback', { option: optName })
              : getUserErrorMessage(error, t('toasts.willResetFallback', { option: optName })),
            variant: 'destructive',
          })
        }
      } else {
        toast({ title: t('toasts.failedToUpdateTitle'), description: response?.error || t('toasts.unknownError'), variant: 'destructive' })
      }
    } catch (error) {
      toast({ title: t('toasts.error'), description: getUserErrorMessage(error, t('toasts.setOptionFailed')), variant: 'destructive' })
    } finally {
      setSavingOptions(prev => {
        const next = new Set(prev)
        next.delete(optName)
        return next
      })
    }
  }, [toast, t, serverChangedSinceLoad])

  // PanelBridge 1.7.70 and older save an enum's last value N as N-1 and call
  // it confirmed (see describeModEnumControl), so the panel holds N back
  // until the server runs the current bridge.
  const refuseBlockedEnumValue = useCallback((optName: string, value: number) => {
    toast({
      title: t('toasts.enumLastChoiceRefusedTitle'),
      description: t('toasts.enumLastChoiceRefusedDesc', { option: optName, max: value }),
      variant: 'warning',
    })
  }, [toast, t])

  // File browser: open the dialog for a specific INI key
  const openFileBrowser = useCallback(async (key: string, extensions?: string[]) => {
    setFileBrowserKey(key)
    setFileBrowserExtensions(extensions || ['.png', '.jpg', '.jpeg'])
    setFileBrowserSelected(null)
    setFileBrowserOpen(true)
    setFileBrowserLoading(true)
    try {
      // Start browsing from server config path (or current value's directory)
      const currentValue = iniSettings[key]
      let startPath: string | undefined
      if (currentValue) {
        // Try the directory of the current value
        const lastSlash = Math.max(currentValue.lastIndexOf('/'), currentValue.lastIndexOf('\\'))
        if (lastSlash > 0) startPath = currentValue.substring(0, lastSlash)
      }
      const data = await serverFilesApi.browseFiles(startPath, extensions)
      setFileBrowserPath(data.currentPath)
      setFileBrowserDirs(data.directories)
      setFileBrowserFiles(data.files)
      setFileBrowserParent(data.parent)
    } catch {
      toast({ title: t('toasts.error'), description: t('toasts.browseFilesFailed'), variant: 'destructive' })
    } finally {
      setFileBrowserLoading(false)
    }
  }, [iniSettings, toast, t])

  // File browser: navigate to a directory
  const browseTo = useCallback(async (dirPath: string) => {
    setFileBrowserLoading(true)
    setFileBrowserSelected(null)
    try {
      const data = await serverFilesApi.browseFiles(dirPath, fileBrowserExtensions)
      setFileBrowserPath(data.currentPath)
      setFileBrowserDirs(data.directories)
      setFileBrowserFiles(data.files)
      setFileBrowserParent(data.parent)
    } catch {
      toast({ title: t('toasts.error'), description: t('toasts.navigateFailed'), variant: 'destructive' })
    } finally {
      setFileBrowserLoading(false)
    }
  }, [fileBrowserExtensions, toast, t])

  // File browser: confirm selection
  const confirmFileBrowserSelection = useCallback(() => {
    if (fileBrowserSelected && fileBrowserKey) {
      setIniSettings(prev => ({ ...prev, [fileBrowserKey]: fileBrowserSelected }))
      setFileBrowserOpen(false)
    }
  }, [fileBrowserSelected, fileBrowserKey])

  const handleSaveIni = async () => {
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.error'),
        description: t('toasts.serverChangedSinceLoad'),
        variant: 'destructive',
      })
      return
    }
    setSaving(true)
    try {
      if (editorMode === 'structured' && invalidIniSettings.length > 0) {
        toast({
          title: t('toasts.invalidIniTitle'),
          description: t('toasts.fixSettings', { settings: invalidIniSettings.map(getIniSettingLabel).join(listSep) }),
          variant: 'destructive',
        })
        return
      }
      if (editorMode === 'raw') {
        await serverFilesApi.saveRaw('ini', rawContent)
        setOriginalRawContent(rawContent)
      } else {
        const payload = buildIniSavePayload(iniSettings, originalIniSettings, iniDefaultedKeys)
        await serverFilesApi.saveIni(payload)
        setOriginalIniSettings({ ...iniSettings })
        setIniDefaultedKeys(new Set([...iniDefaultedKeys].filter(key => !(key in payload))))
        // PUT /ini rewrote every sent key's line as Key=value.
        setIniMisnamedKeys(Object.fromEntries(Object.entries(iniMisnamedKeys).filter(([key]) => !(key in payload))))
      }

      // Try to reload via RCON, but don't fail if RCON is not connected
      try {
        await serverFilesApi.saveAndReload()
        toast({ title: t('toasts.savedAndReloadedTitle'), description: t('toasts.savedIniReloadedDesc') })
      } catch {
        // File was saved, but RCON reload failed - that's okay
        toast({ title: t('toasts.savedTitle'), description: t('toasts.savedRestartToApply') })
      }

      // Refresh from server to ensure frontend matches the saved file
      try {
        if (editorMode === 'raw') {
          loadData()
        } else {
          applyIniData(await serverFilesApi.getIni())
        }
      } catch { /* silent refresh — local state is still valid */ }
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.saveSettingsFailed')),
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSaveSandbox = async () => {
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.error'),
        description: t('toasts.serverChangedSinceLoad'),
        variant: 'destructive',
      })
      return
    }
    setSaving(true)
    try {
      if (editorMode === 'structured' && invalidSandboxSettings.length > 0) {
        toast({
          title: t('toasts.invalidSandboxTitle'),
          description: t('toasts.fixSettings', { settings: invalidSandboxSettings.map(getSandboxSettingLabel).join(listSep) }),
          variant: 'destructive',
        })
        return
      }
      // Sandbox settings have no RCON live-reload path: PZ's own /reloadoptions
      // command only re-reads ServerOptions.ini, never SandboxVars.lua (see
      // PanelBridge.lua's own comment to that effect). Unlike the INI save
      // below, a sandbox change always needs a restart to reach the running
      // game -- whether the server is stopped right now or running -- so
      // this never attempts a live reload and never claims one succeeded.
      if (editorMode === 'raw') {
        await serverFilesApi.saveRaw('sandbox', rawContent)
        setOriginalRawContent(rawContent)
      } else if (sandboxData) {
        // Create a deep copy to sanitize numbers
        const cleanData = JSON.parse(JSON.stringify(sandboxData)) as SandboxData

        // Ensure numbers are finite, canonical numbers before writing Lua.
        // Uses the same effective (live-preferred) bounds and the same
        // escape hatch as invalidSandboxSettings above -- otherwise a value
        // the Save button just allowed through (toggle on, out of range)
        // would throw right here instead, at the one place it's actually
        // written.
        effectiveSandboxSchema.forEach(setting => {
          if (setting.type === 'number') {
            const section = (setting.section || 'settings') as keyof SandboxData
            if (cleanData[section]) {
              const sectionData = cleanData[section] as SandboxRecord
              const raw = sectionData[setting.key]
              if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
                const parsed = parseNumericSettingValue(raw, setting, { enforceBounds: !allowOutOfRangeSandbox })
                if (parsed === null) throw new Error(t('toasts.settingInvalid', { label: getSandboxSettingLabel(setting) }))
                sectionData[setting.key] = parsed
              }
            }
          }
        })

        const sandboxSaveResult = await serverFilesApi.saveSandbox(cleanData)
        // Update local state to match sanitized data
        setSandboxData(cleanData)
        setOriginalSandboxData(cleanData)

        // The server verifies this write by reading the file back (see its
        // own comment on this route) specifically because a key with no
        // matching line to update is silently dropped otherwise -- that
        // read-back is inert unless something on this end actually surfaces
        // it, so without this the operator still saw a plain "Saved" toast
        // for a save that partially failed.
        const unpersistedKeys = getUnpersistedSandboxKeys(sandboxSaveResult)
        if (unpersistedKeys) {
          toast({
            title: t('toasts.someSandboxKeysNotSavedTitle'),
            description: t('toasts.someSandboxKeysNotSavedDesc', {
              keys: unpersistedKeys.join(', '),
            }),
            variant: 'destructive',
          })
        }
      }

      toast({ title: t('toasts.savedTitle'), description: t('toasts.savedRestartToApply') })

      // Refresh from server to ensure frontend matches the saved file
      try {
        if (editorMode === 'raw') {
          loadData()
        } else {
          const sandboxRes = await serverFilesApi.getSandbox()
          setSandboxData(sandboxRes.sandbox)
          setOriginalSandboxData(sandboxRes.sandbox)
          setSandboxParseError(sandboxRes.parseError?.message || null)
          setWorldSandboxSnapshot(sandboxRes.worldSandboxSnapshot ?? null)
        }
      } catch { /* silent refresh — local state is still valid */ }
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.saveSettingsFailed')),
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSaveSpawnPoints = async () => {
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.error'),
        description: t('toasts.serverChangedSinceLoad'),
        variant: 'destructive',
      })
      return
    }
    setSaving(true)
    try {
      const result = editorMode === 'raw'
        ? await serverFilesApi.saveRaw('spawnpoints', rawContent)
        : await serverFilesApi.saveSpawnPoints(spawnPoints)
      toast({
        title: t('toasts.savedTitle'),
        description: result?.restartRequired ? t('toasts.savedRestartToApply') : t('toasts.spawnPointsSavedDesc'),
      })
      if (editorMode === 'raw') {
        // What is in the textarea is now the file: not an unsaved edit.
        setOriginalRawContent(rawContent)
        loadData()
      }
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.saveSpawnPointsFailed')),
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSaveSpawnRegions = async () => {
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.error'),
        description: t('toasts.serverChangedSinceLoad'),
        variant: 'destructive',
      })
      return
    }
    setSaving(true)
    try {
      const result = editorMode === 'raw'
        ? await serverFilesApi.saveRaw('spawnregions', rawContent)
        : await serverFilesApi.saveSpawnRegions(spawnRegions)
      toast({
        title: t('toasts.savedTitle'),
        description: result?.restartRequired ? t('toasts.savedRestartToApply') : t('toasts.spawnRegionsSavedDesc'),
      })
      if (editorMode === 'raw') {
        // What is in the textarea is now the file: not an unsaved edit.
        setOriginalRawContent(rawContent)
        loadData()
      } else {
        setOriginalSpawnRegions(spawnRegions)
      }
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.saveSpawnRegionsFailed')),
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }


  // Per-setting modified / non-default predicates (centralized so filter + badges use the same logic)
  const isIniModified = useCallback((s: IniSetting) => {
    const curr = iniSettings[s.key]
    const orig = originalIniSettings[s.key]
    return curr !== orig && orig !== undefined
  }, [iniSettings, originalIniSettings])

  // Against the value the game ends up with, as the row's default highlight.
  const isIniNonDefault = useCallback((s: IniSetting) => {
    if (s.defaultComparable === false) return false
    const curr = iniSettings[s.key]
    if (curr === undefined) return false
    return !iniValueIsDefault(s, String(curr))
  }, [iniSettings])

  const isSandboxModified = useCallback((s: SandboxSetting) => {
    if (!sandboxData || !originalSandboxData) return false
    const section = (s.section || 'settings') as keyof SandboxData
    const curr = (sandboxData[section] as SandboxRecord)?.[s.key]
    const orig = (originalSandboxData[section] as SandboxRecord)?.[s.key]
    return JSON.stringify(curr) !== JSON.stringify(orig)
  }, [sandboxData, originalSandboxData])

  const isSandboxNonDefault = useCallback((s: SandboxSetting) => {
    if (!sandboxData) return false
    const section = (s.section || 'settings') as keyof SandboxData
    const curr = (sandboxData[section] as SandboxRecord)?.[s.key]
    if (curr === undefined || curr === null) return false
    return String(curr) !== String(s.default ?? '')
  }, [sandboxData])

  // Filter settings by search + filter mode. A legacy (Build 41-only) key is
  // listed only when the loaded file has it, so a Build 42 file never offers
  // one to fill in.
  const filteredIniSettings = useMemo(() => {
    const lower = deferredSearchQuery.toLocaleLowerCase(searchLocale)
    const filtered = INI_SCHEMA.filter(s => {
      if (s.legacy && !(s.key in originalIniSettings)) return false
      if (deferredSearchQuery && !getIniSettingSearchText(s).toLocaleLowerCase(searchLocale).includes(lower)) return false
      if (filterMode === 'modified' && !isIniNonDefault(s)) return false
      if (filterMode === 'nondefault' && !isIniModified(s)) return false
      return true
    })
    return groupByCategory(filtered)
  }, [deferredSearchQuery, filterMode, isIniModified, isIniNonDefault, searchLocale, originalIniSettings])

  const filteredSandboxSettings = useMemo(() => {
    const lower = deferredSearchQuery.toLocaleLowerCase(searchLocale)
    const filtered = effectiveSandboxSchema.filter(s => {
      if (deferredSearchQuery && !getSandboxSettingSearchText(s).toLocaleLowerCase(searchLocale).includes(lower)) return false
      if (filterMode === 'modified' && !isSandboxNonDefault(s)) return false
      if (filterMode === 'nondefault' && !isSandboxModified(s)) return false
      return true
    })
    return groupByCategory(filtered)
  }, [deferredSearchQuery, filterMode, isSandboxModified, isSandboxNonDefault, searchLocale, effectiveSandboxSchema])

  // Modified-count per category for rail badges
  const iniModifiedByCategory = useMemo(() => {
    const out: Record<string, number> = {}
    for (const s of INI_SCHEMA) if (isIniModified(s)) out[s.category] = (out[s.category] || 0) + 1
    return out
  }, [isIniModified])

  const sandboxModifiedByCategory = useMemo(() => {
    const out: Record<string, number> = {}
    for (const s of SANDBOX_SCHEMA) if (isSandboxModified(s)) out[s.category] = (out[s.category] || 0) + 1
    return out
  }, [isSandboxModified])

  // Unknown INI keys — keys present in the loaded file but not in the schema.
  // Mirrors the sandbox `uncategorized` pattern so mod-injected / new-vanilla keys remain editable.
  const uncategorizedIniKeys = useMemo(() => {
    const schemaKeys = new Set(INI_SCHEMA.map(s => s.key))
    const lower = deferredSearchQuery.toLowerCase()
    const out: { key: string; value: string }[] = []
    for (const [key, value] of Object.entries(iniSettings)) {
      if (schemaKeys.has(key) || UNSUPPORTED_INI_KEYS.has(key)) continue
      if (deferredSearchQuery && !(
        key.toLowerCase().includes(lower) ||
        String(value).toLowerCase().includes(lower)
      )) continue
      out.push({ key, value })
    }
    return out.sort((a, b) => a.key.localeCompare(b.key))
  }, [iniSettings, deferredSearchQuery])

  // Find sandbox settings not covered by the schema (mod settings, etc.)
  const uncategorizedSandboxKeys = useMemo(() => {
    if (!sandboxData) return []
    const schemaKeys = new Set(SANDBOX_SCHEMA.map(s => `${s.section || 'settings'}.${s.key}`))
    const uncategorized: { section: string; key: string; value: string | number | boolean }[] = []

    for (const sectionName of Object.keys(sandboxData)) {
      if (sectionName === 'VERSION') continue
      const sectionData = sandboxData[sectionName as keyof SandboxData]
      if (typeof sectionData !== 'object' || sectionData === null) continue
      for (const [key, value] of Object.entries(sectionData as Record<string, string | number | boolean>)) {
        if (key === 'VERSION') continue // file-format marker, not an editable setting
        if (!schemaKeys.has(`${sectionName}.${key}`)) {
          const lower = deferredSearchQuery?.toLowerCase() || ''
          if (!deferredSearchQuery || key.toLowerCase().includes(lower) || String(value).toLowerCase().includes(lower)) {
            uncategorized.push({ section: sectionName, key, value })
          }
        }
      }
    }
    return uncategorized.sort((a, b) => {
      if (a.section !== b.section) return a.section.localeCompare(b.section)
      return a.key.localeCompare(b.key)
    })
  }, [sandboxData, deferredSearchQuery])

  const uncategorizedGroups = useMemo(() => {
    const groups: Record<string, typeof uncategorizedSandboxKeys> = {}
    for (const entry of uncategorizedSandboxKeys) {
      const list = groups[entry.section] || (groups[entry.section] = [])
      list.push(entry)
    }
    return groups
  }, [uncategorizedSandboxKeys])

  // Load backups
  const loadBackups = async () => {
    try {
      const data = await serverFilesApi.getBackups()
      setBackups(data.backups)
      setShowBackups(true)
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.loadBackupsFailed')),
        variant: 'destructive'
      })
    }
  }

  // Restore backup
  const handleRestoreBackup = async (filename: string) => {
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.error'),
        description: t('toasts.serverChangedSinceLoad'),
        variant: 'destructive',
      })
      return
    }
    const ok = await confirm({
      title: t('restoreBackupConfirm.title'),
      description: t('restoreBackupConfirm.description', { filename }),
      confirmLabel: t('restoreBackupConfirm.confirmLabel'),
    })
    if (!ok) return

    try {
      await serverFilesApi.restoreBackup(filename)
      toast({ title: t('toasts.restoredTitle'), description: t('toasts.restoredDesc', { filename }) })
      setShowBackups(false)
      loadData()
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.restoreBackupFailed')),
        variant: 'destructive'
      })
    }
  }

  // Move the world's map_sand.bin aside so the next start uses SandboxVars.lua
  // (#197). The server refuses while the game runs; the button is disabled
  // then too.
  const handleRetireWorldSandboxSnapshot = async () => {
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.error'),
        description: t('toasts.serverChangedSinceLoad'),
        variant: 'destructive',
      })
      return
    }
    const ok = await confirm({
      title: t('worldSandboxSnapshotBanner.confirmTitle'),
      description: t('worldSandboxSnapshotBanner.confirmDesc'),
      confirmLabel: t('worldSandboxSnapshotBanner.confirmLabel'),
    })
    if (!ok) return

    setRetiringWorldSandboxSnapshot(true)
    try {
      const result = await serverFilesApi.retireWorldSandboxSnapshot()
      if (result.retired && result.movedTo) {
        toast({
          title: t('toasts.worldSandboxSnapshotRetiredTitle'),
          description: t('toasts.worldSandboxSnapshotRetiredDesc', { path: result.movedTo }),
        })
      }
      setWorldSandboxSnapshot(null)
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.worldSandboxSnapshotRetireFailed')),
        variant: 'destructive',
      })
    } finally {
      setRetiringWorldSandboxSnapshot(false)
    }
  }

  // Load templates
  const loadTemplates = async () => {
    setTemplateLoading(true)
    try {
      const data = await serverFilesApi.getTemplates()
      setTemplates(data.templates)
      setShowTemplates(true)
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.loadTemplatesFailed')),
        variant: 'destructive'
      })
    } finally {
      setTemplateLoading(false)
    }
  }

  // Save current config as template
  const handleSaveTemplate = async () => {
    if (!newTemplateName.trim()) {
      toast({ title: t('toasts.error'), description: t('toasts.templateNameRequired'), variant: 'destructive' })
      return
    }

    // pz-bughunt round 18: saveAsTemplate() sends no ini/sandbox VALUES --
    // the server reads whatever's currently on disk for "the active
    // server" at save time, with no id sent. If the active server changed
    // while this Save-as-Template dialog was open, the resulting template
    // (named/described while looking at server A) would actually capture
    // server B's live config -- a correctness/confusion surprise, same
    // shape as (if lower severity than) handleSaveIni/handleSaveSandbox's
    // own guard just above. Same flag, same toast.
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.error'),
        description: t('toasts.serverChangedSinceLoad'),
        variant: 'destructive',
      })
      return
    }

    setTemplateLoading(true)
    try {
      const result = await serverFilesApi.saveAsTemplate({
        name: newTemplateName.trim(),
        description: newTemplateDesc.trim(),
        includeIni: saveTemplateIni,
        includeSandbox: saveTemplateSandbox
      })
      toast({ title: t('toasts.savedTitle'), description: result.message })
      setShowSaveTemplate(false)
      setNewTemplateName('')
      setNewTemplateDesc('')
      // Refresh template list if dialog is open
      if (showTemplates) {
        const data = await serverFilesApi.getTemplates()
        setTemplates(data.templates)
      }
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.saveTemplateFailed')),
        variant: 'destructive'
      })
    } finally {
      setTemplateLoading(false)
    }
  }

  // Apply template
  const handleApplyTemplate = async (template: ConfigTemplate) => {
    // Templates never store the RCON/server password or any token
    // (POST /templates strips them at save time -- see
    // stripSensitiveIniLines() in utils/iniSecretLines.js), and applying an
    // INI section keeps the live file's own (keepLiveSecretIniLines()).
    // Applying used to remove them from the live config, with a warning
    // that only named the RCON password; now it says they stay.
    const ok = await confirm({
      title: t('applyTemplateConfirm.title', { name: template.name }),
      description: template.hasIni
        ? `${t('applyTemplateConfirm.description')}\n\n${t('applyTemplateConfirm.secretsKept')}`
        : t('applyTemplateConfirm.description'),
      confirmLabel: t('applyTemplateConfirm.confirmLabel'),
    })
    if (!ok) return

    setTemplateLoading(true)
    try {
      const result = await serverFilesApi.applyTemplate(template.id)
      toast({
        title: t('toasts.appliedTitle'),
        description: result.message
      })
      const backupWarnings = getApplyTemplateBackupWarnings(result)
      if (backupWarnings) {
        toast({
          title: t('toasts.applyTemplateBackupWarningTitle'),
          description: t('toasts.applyTemplateBackupWarningDesc', {
            warnings: backupWarnings.join(' '),
          }),
          variant: 'destructive',
        })
      }
      setShowTemplates(false)
      loadData() // Reload the config data
    } catch (error) {
      const partiallyApplied = getPartiallyAppliedFromApplyTemplateError(error)
      if (partiallyApplied) {
        toast({
          title: t('toasts.applyTemplatePartialTitle'),
          description: t('toasts.applyTemplatePartialDesc', {
            applied: partiallyApplied.join(', '),
            error: getUserErrorMessage(error, t('toasts.applyTemplateFailed')),
          }),
          variant: 'destructive'
        })
        // The part that landed is now the live config -- reload so the
        // editor reflects disk instead of showing what was there before
        // the apply, which would silently disagree with the real file.
        loadData()
      } else {
        toast({
          title: t('toasts.error'),
          description: getUserErrorMessage(error, t('toasts.applyTemplateFailed')),
          variant: 'destructive'
        })
      }
    } finally {
      setTemplateLoading(false)
    }
  }

  // Delete template
  const handleDeleteTemplate = async (id: string, name: string) => {
    const ok = await confirm({
      title: t('deleteTemplateConfirm.title'),
      description: t('deleteTemplateConfirm.description', { name }),
      confirmLabel: t('deleteTemplateConfirm.confirmLabel'),
    })
    if (!ok) return

    try {
      await serverFilesApi.deleteTemplate(id)
      toast({ title: t('toasts.deletedTitle'), description: t('toasts.templateDeletedDesc', { name }) })
      setTemplates(prev => prev.filter(tpl => tpl.id !== id))
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.deleteTemplateFailed')),
        variant: 'destructive'
      })
    }
  }

  // Optimized update handlers
  const updateIniValue = useCallback((key: string, value: string) => {
    setIniSettings(prev => ({ ...prev, [key]: value }))
  }, [])

  // Unresolved Mods= triage actions (mods-unresolved-2026-08-31) -- both
  // stage an edit into the SAME unsaved iniSettings state as manually typing
  // in the field below would; nothing reaches disk until the operator hits
  // Save, same as every other edit on this page. That's what makes these
  // safe to offer without the bulk-disable the mods.resolved check's own
  // comment (Debug.tsx) deliberately avoids.
  const applyUnresolvedModCorrection = useCallback((modId: string, suggestion: string) => {
    setIniSettings(prev => {
      const tokens = (prev.Mods || '').split(';').map(v => v.trim()).filter(Boolean)
      const next = tokens.map(v => (v === modId ? suggestion : v))
      return { ...prev, Mods: next.join(';') }
    })
    toast({
      title: t('unresolvedReview.correctedTitle'),
      description: t('unresolvedReview.correctedToast', { modId, suggestion }),
    })
  }, [toast, t])

  const removeUnresolvedModEntry = useCallback(async (modId: string) => {
    const ok = await confirm({
      title: t('unresolvedReview.removeConfirmTitle'),
      description: t('unresolvedReview.removeConfirm', { modId }),
      confirmLabel: t('unresolvedReview.removeConfirmButton'),
      destructive: true,
    })
    if (!ok) return
    setIniSettings(prev => {
      const tokens = (prev.Mods || '').split(';').map(v => v.trim()).filter(Boolean)
      return { ...prev, Mods: tokens.filter(v => v !== modId).join(';') }
    })
    toast({
      title: t('unresolvedReview.removedTitle'),
      description: t('unresolvedReview.removedToast', { modId }),
    })
  }, [confirm, toast, t])

  const updateSandboxValue = useCallback((setting: SandboxSetting, value: SandboxScalar) => {
    setSandboxData(prev => {
      if (!prev) return prev
      const section = (setting.section || 'settings') as keyof SandboxData
      const sectionData = { ...(prev[section] as Record<string, unknown> || {}) }
      sectionData[setting.key] = value
      return { ...prev, [section]: sectionData } as SandboxData
    })
  }, [])

  // Reset individual INI setting to original loaded value
  const resetIniValue = useCallback((key: string) => {
    if (originalIniSettings[key] !== undefined) {
      setIniSettings(prev => ({ ...prev, [key]: originalIniSettings[key] }))
    }
  }, [originalIniSettings])

  // Discard all unsaved INI changes (sticky save bar)
  const discardIniChanges = useCallback(() => {
    setIniSettings({ ...originalIniSettings })
    // bug-hunt-2026-09-18 (round 22): hasIniChanges compares rawContent
    // against originalRawContent while editorMode === 'raw' instead of
    // iniSettings -- resetting only iniSettings left the raw textarea (and
    // the "Unsaved changes" badge it drives) untouched, so Discard silently
    // did nothing visible in raw mode.
    if (editorMode === 'raw') setRawContent(originalRawContent)
  }, [originalIniSettings, editorMode, originalRawContent])

  // Discard all unsaved Sandbox changes (sticky save bar)
  const discardSandboxChanges = useCallback(() => {
    if (originalSandboxData) setSandboxData(JSON.parse(JSON.stringify(originalSandboxData)))
    if (editorMode === 'raw') setRawContent(originalRawContent)
  }, [originalSandboxData, editorMode, originalRawContent])

  // Reset individual Sandbox setting to original loaded value
  const resetSandboxValue = useCallback((setting: SandboxSetting) => {
    if (!originalSandboxData || !sandboxData) return
    const section = (setting.section || 'settings') as keyof SandboxData
    const originalSection = originalSandboxData[section] as SandboxRecord | undefined
    if (originalSection && originalSection[setting.key] !== undefined) {
      setSandboxData(prev => {
        if (!prev) return prev
        return {
          ...prev,
          [section]: {
            ...(prev[section] as SandboxRecord),
            [setting.key]: originalSection[setting.key]
          }
        }
      })
    }
  }, [originalSandboxData, sandboxData])

  // Count changed INI settings
  const changedIniCount = useMemo(() => {
    let count = 0
    for (const key of Object.keys(iniSettings)) {
      if (originalIniSettings[key] !== undefined && iniSettings[key] !== originalIniSettings[key]) count++
    }
    return count
  }, [iniSettings, originalIniSettings])

  // Count changed Sandbox settings
  const changedSandboxCount = useMemo(() => {
    if (!sandboxData || !originalSandboxData) return 0
    let count = 0
    SANDBOX_SCHEMA.forEach(setting => {
      const section = (setting.section || 'settings') as keyof SandboxData
      const curr = (sandboxData[section] as SandboxRecord)?.[setting.key]
      const orig = (originalSandboxData[section] as SandboxRecord)?.[setting.key]
      if (JSON.stringify(curr) !== JSON.stringify(orig)) count++
    })
    return count
  }, [sandboxData, originalSandboxData])

  // Search results count
  const searchResultsCount = useMemo(() => {
    if (!deferredSearchQuery) return 0
    if (activeTab === 'ini') {
      return Object.values(filteredIniSettings).reduce((acc, settings) => acc + settings.length, 0)
    }
    if (activeTab === 'sandbox') {
      return Object.values(filteredSandboxSettings).reduce((acc, settings) => acc + settings.length, 0)
    }
    return 0
  }, [deferredSearchQuery, activeTab, filteredIniSettings, filteredSandboxSettings])

  // The Spawn Regions list's own Discard, and the raw editor's (Spawn Points).
  const discardSpawnRegionChanges = useCallback(() => {
    setSpawnRegions(originalSpawnRegions)
    if (editorMode === 'raw') setRawContent(originalRawContent)
  }, [originalSpawnRegions, editorMode, originalRawContent])
  const discardRawEdits = useCallback(() => setRawContent(originalRawContent), [originalRawContent])

  // Regions added, removed or edited since the load.
  const changedSpawnRegionCount = useMemo(() => {
    let count = Math.abs(spawnRegions.length - originalSpawnRegions.length)
    const shared = Math.min(spawnRegions.length, originalSpawnRegions.length)
    for (let i = 0; i < shared; i++) {
      if (JSON.stringify(spawnRegions[i]) !== JSON.stringify(originalSpawnRegions[i])) count++
    }
    return count
  }, [spawnRegions, originalSpawnRegions])

  // /server-config?open=snapshots (the Templates page's link to config
  // snapshots): open that dialog, then drop the parameter so a reload or
  // Back doesn't open it again.
  const openParam = searchParams.get('open')
  useEffect(() => {
    if (openParam !== 'snapshots') return
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      next.delete('open')
      return next
    }, { replace: true })
    if (canManageServerFiles) void loadTemplates()
  }, [openParam]) // eslint-disable-line react-hooks/exhaustive-deps -- once per ?open=snapshots

  // Stats for the header's fact row
  const iniSettingsCount = Object.keys(iniSettings).length
  const sandboxSettingsCount = sandboxData ? Object.keys(sandboxData.settings || {}).length : 0
  const spawnPointsCount = Object.values(spawnPoints).reduce((acc, points) => acc + points.length, 0)
  const professionsCount = Object.keys(spawnPoints).length

  // The one save affordance (SaveBar) follows the tab on screen: what it
  // saves, what Discard puts back, and the Save wording each tab always had
  // ("Save & reload" only where an RCON reload really is attempted).
  const saveTarget = ((): {
    dirty: boolean
    onSave: () => void
    onDiscard: () => void
    saveLabel: string
    changeCount?: number
    invalid: boolean
  } | null => {
    const structured = editorMode === 'structured'
    switch (activeTab) {
      case 'ini':
        return {
          dirty: hasIniChanges,
          onSave: () => { void handleSaveIni() },
          onDiscard: discardIniChanges,
          saveLabel: t('editorToolbar.saveAndReload'),
          changeCount: structured ? changedIniCount : undefined,
          invalid: structured && invalidIniSettings.length > 0,
        }
      case 'sandbox':
        return {
          dirty: hasSandboxChanges,
          onSave: () => { void handleSaveSandbox() },
          onDiscard: discardSandboxChanges,
          saveLabel: t('editorToolbar.save'),
          changeCount: structured ? changedSandboxCount : undefined,
          invalid: structured && invalidSandboxSettings.length > 0,
        }
      case 'spawnpoints':
        return {
          dirty: hasSpawnPointChanges,
          onSave: () => { void handleSaveSpawnPoints() },
          onDiscard: discardRawEdits,
          saveLabel: t('editorToolbar.save'),
          invalid: false,
        }
      case 'spawnregions':
        return {
          dirty: hasSpawnRegionChanges,
          onSave: () => { void handleSaveSpawnRegions() },
          onDiscard: discardSpawnRegionChanges,
          saveLabel: t('editorToolbar.save'),
          changeCount: structured ? changedSpawnRegionCount : undefined,
          invalid: false,
        }
      default:
        return null
    }
  })()
  const saveDisabledReason = serverChangedSinceLoad
    ? t('toasts.serverChangedSinceLoad')
    : saveTarget?.invalid
      ? t('invalidValuesAlert.title')
      : undefined

  // ── Header ──────────────────────────────────────────────────────────────
  const serverMeta = (
    <>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {pathsInfo ? (
          <span className="font-medium text-foreground">{pathsInfo.serverName}</span>
        ) : activeServerName ? (
          // pathsInfo is null here because the load failed -- but a
          // remote-without-SFTP-transport failure (see loadData) still
          // means a real server is active, just not this one, so say so
          // instead of "No server selected", which the sidebar right
          // next to this page already contradicts.
          <span className="font-medium text-foreground">{activeServerName}</span>
        ) : (
          <span>{t('activeServerStrip.noServerSelected')}</span>
        )}
      </span>
      {pathsInfo && (
        <span className="min-w-0 max-w-full truncate font-mono" title={pathsInfo.configPath} dir="ltr">
          {pathsInfo.configPath}
        </span>
      )}
      <StatChip
        icon={<Settings className="h-3.5 w-3.5" />}
        value={iniSettingsCount}
        label={t('activeServerStrip.iniLabel')}
        ok={pathsInfo?.exists.ini}
      />
      <StatChip
        icon={<FileText className="h-3.5 w-3.5" />}
        value={sandboxSettingsCount}
        label={t('activeServerStrip.sandboxLabel')}
        ok={pathsInfo?.exists.sandbox}
      />
      <StatChip
        icon={<MapPin className="h-3.5 w-3.5" />}
        value={spawnPointsCount}
        label={t('activeServerStrip.spawnsLabel', { count: professionsCount })}
      />
      <StatChip
        icon={<Map className="h-3.5 w-3.5" />}
        value={spawnRegions.length}
        label={t('activeServerStrip.regionsLabel')}
      />
    </>
  )

  const moreItems: RowActionItem[] = [
    { label: t('pageHeader.backups'), icon: History, onSelect: () => { void loadBackups() } },
    { label: t('pageHeader.templatesPage'), icon: LayoutTemplate, onSelect: () => { void guardedNavigate('/templates') } },
    // Server Files is its own capability; the sidebar hides it without one.
    ...(can('files.manage')
      ? [{ label: t('pageHeader.openInFiles'), icon: FolderTree, onSelect: () => { void guardedNavigate(SERVER_FILES_CONFIG_LINK) } }]
      : []),
  ]

  const header = (
    <PageHeader
      title={t('pageHeader.title')}
      description={t('pageHeader.description')}
      status={hasUnsavedChanges ? <StatusPill tone="warn" size="sm" label={t('pageHeader.unsavedChanges')} /> : undefined}
      meta={canManageServerFiles && !loading ? serverMeta : undefined}
      actions={canManageServerFiles ? (
        <>
          <Button
            variant="ghost"
            size="iconDense"
            onClick={() => loadData({ manual: true })}
            disabled={loading}
            aria-label={t('pageHeader.refresh')}
          >
            <RefreshCw className={cn(loading && 'motion-safe:animate-spin')} aria-hidden="true" />
          </Button>
          <Button variant="outline" size="sm" onClick={loadTemplates} disabled={templateLoading} aria-label={t('pageHeader.templates')}>
            {templateLoading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
            <span className="hidden sm:inline">{t('pageHeader.templates')}</span>
          </Button>
          <RowActions items={moreItems} ariaLabel={t('pageHeader.more')} />
        </>
      ) : undefined}
    />
  )

  if (!canManageServerFiles) {
    return (
      <div className="space-y-6 page-transition">
        {header}
        <EmptyState
          type="noData"
          title={t('noAccess.title')}
          description={t('noAccess.description')}
        />
      </div>
    )
  }

  if (loading) {
    return (
      <div className="space-y-6 page-transition">
        {header}
        <div className="space-y-4" role="status" aria-busy="true" aria-label={t('loading')}>
          <Skeleton className="h-11 w-full sm:h-10" />
          <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-9 w-full max-w-md" />
            <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
              <div className="hidden space-y-2 lg:block">
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
              <div className="space-y-3">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Alerts ──────────────────────────────────────────────────────────────
  // Page-level: the load itself, a server switch, and files the game can't
  // read at all. Everything else sits at the top of the tab it is about.
  const pageAlerts: PageAlert[] = []
  if (loadError) {
    pageAlerts.push(activeServerRemote
      // Remote-with-no-SFTP-transport isn't a failure to retry -- it's a
      // configuration step the operator hasn't done yet (same class as
      // Backups.tsx's/ChunkCleaner's own remote-server alerts), so this
      // is a warning without a Retry: retrying can't turn a remote server
      // into a local one, or add SFTP details on its own.
      ? { id: 'load-error', tone: 'warning', title: t('loadErrorTitle'), description: <span className="break-words" dir="auto">{loadError}</span> }
      : {
          id: 'load-error',
          tone: 'error',
          title: t('loadErrorTitle'),
          description: <span className="break-words" dir="auto">{loadError}</span>,
          action: { label: t('retry'), onClick: () => loadData({ manual: true }) },
        })
  }
  if (serverChangedSinceLoad) {
    pageAlerts.push({
      id: 'server-changed',
      tone: 'error',
      title: t('serverChangedBanner.title'),
      description: t('serverChangedBanner.desc'),
      action: { label: t('retry'), onClick: () => loadData({ manual: true }) },
    })
  }
  // A server.ini line the game can't make an option of ("= x", "Version=")
  // makes it ignore the WHOLE file: ServerOptions applies nothing from it, so
  // the server runs on the default of every setting and every value this
  // page shows is moot. The form can't show such a line, so the alert names
  // it for the raw editor (server/utils/iniGameView.js findIniFatalLines).
  if (shownIniFatalLines.length > 0) {
    pageAlerts.push({
      id: 'ini-fatal-lines',
      tone: 'error',
      title: t('iniFatalLinesBanner.title'),
      description: t('iniFatalLinesBanner.desc', { count: shownIniFatalLines.length, lines: shownIniFatalLines.join(listSep) }),
    })
  }
  // SandboxVars.lua the game can't load (the #197 "Explosives = 1"
  // corruption, a hand edit gone wrong, a file with no SandboxVars table):
  // the form has nothing to show and PUT /sandbox refuses to edit it, so say
  // why and where to fix it. The detail is the parser's own message, the
  // same wording the game logs.
  if (sandboxParseError) {
    pageAlerts.push({
      id: 'sandbox-parse-error',
      tone: 'error',
      title: t('sandboxParseErrorBanner.title'),
      description: (
        <span className="block space-y-1">
          <code className="block break-words font-mono text-xs" dir="ltr">{sandboxParseError}</code>
          <span className="block">{t('sandboxParseErrorBanner.desc')}</span>
        </span>
      ),
    })
  }
  // A setting that appears more than once as its own line in the raw INI.
  // This editor's parseIni() lets the LAST occurrence win, while the Mods
  // page's own reads/writes only ever see the FIRST -- two screens showing
  // different values for the same nominal setting. Same condition as
  // Mods.tsx's own duplicateKeysWarning (see server/utils/iniDuplicateKeys.js).
  if (duplicateKeys.length > 0) {
    pageAlerts.push({
      id: 'duplicate-keys',
      tone: 'warning',
      title: t('duplicateKeysWarning.title', { count: duplicateKeys.length, keys: duplicateKeys.map(d => d.key).join(', ') }),
      description: t('duplicateKeysWarning.desc'),
    })
  }

  const stopServerAlert: PageAlert | null = serverMayBeRunning
    ? {
        id: 'server-running',
        tone: 'info',
        title: serverRunning === true ? t('stopServerAlert.title') : t('stopServerAlert.unknownTitle'),
        description: serverRunning === true ? t('stopServerAlert.description') : t('stopServerAlert.unknownDescription'),
      }
    : null

  // #197: the world save has a map_sand.bin, which the game applies over
  // SandboxVars.lua on every start, so sandbox edits saved to SandboxVars.lua
  // (here, in Raw mode, or in the in-game admin panel) are undone at the next
  // restart. Live edits through PanelBridge are written to it too (the toast
  // says which). The action stays visible while it can't run, with the reason.
  const worldSnapshotAlert: PageAlert | null = worldSandboxSnapshot
    ? {
        id: 'world-sandbox-snapshot',
        tone: 'warning',
        title: t('worldSandboxSnapshotBanner.title'),
        description: (
          <span className="block space-y-2">
            <span className="block">{t('worldSandboxSnapshotBanner.desc', { date: formatDateTime(worldSandboxSnapshot.mtime, { seconds: true }) })}</span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRetireWorldSandboxSnapshot}
                disabled={worldSandboxSnapshotRetireBlocked || retiringWorldSandboxSnapshot}
              >
                {retiringWorldSandboxSnapshot && <Loader2 className="animate-spin" aria-hidden="true" />}
                {t('worldSandboxSnapshotBanner.action')}
              </Button>
              {worldSandboxSnapshotRetireBlocked && (
                <span className="text-xs text-muted-foreground">{t('worldSandboxSnapshotBanner.stopFirst')}</span>
              )}
            </span>
          </span>
        ),
      }
    : null

  // Unresolved Mods= entries handed over by Diagnostics: each with the fix
  // its triage found, plus the way to the Mods page where they are managed.
  const unresolvedModsList = (
    <span className="mt-1 block space-y-3">
      {initialDeepLink.unresolved.map((modId) => {
        const triage = initialDeepLink.unresolvedTriage.get(modId)
        // Chip + action button share one line (both short, never wrap
        // badly); the explanation is its own line below so a long sentence
        // (workshopNotOnDisk especially) can wrap freely without dragging
        // the button out of line with the chip.
        return (
          <span key={modId} className="block">
            <span className="flex flex-wrap items-center gap-2">
              <code className="rounded border border-warning/30 bg-background/50 px-1.5 py-0.5 font-mono text-xs text-foreground">
                {modId}
              </code>
              {triage?.cause === 'typo' && triage.suggestion && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => applyUnresolvedModCorrection(modId, triage.suggestion as string)}
                >
                  {t('unresolvedReview.correctAction', { suggestion: triage.suggestion })}
                </Button>
              )}
              {(triage?.cause === 'stillDownloading' || triage?.cause === 'workshopNotOnDisk') && (
                <Link to="/debug" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                  {t('unresolvedReview.rerunDiagnostics')}
                </Link>
              )}
              {triage?.cause === 'absent' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-destructive/40 text-destructive hover:bg-destructive/10"
                  onClick={() => removeUnresolvedModEntry(modId)}
                >
                  {t('unresolvedReview.removeAction')}
                </Button>
              )}
              {triage?.cause === 'panelBridge' && (
                <Link to="/settings?tab=bridge" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                  {t('unresolvedReview.openBridgeSettings')}
                </Link>
              )}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {!triage && t('unresolvedReview.causeUnknown')}
              {triage?.cause === 'typo' && triage.suggestion && t('unresolvedReview.causeTypo', { suggestion: triage.suggestion })}
              {triage?.cause === 'stillDownloading' && t('unresolvedReview.causeStillDownloading')}
              {triage?.cause === 'workshopNotOnDisk' && t('unresolvedReview.causeWorkshopNotOnDisk')}
              {triage?.cause === 'absent' && t('unresolvedReview.causeAbsent')}
              {triage?.cause === 'panelBridge' && t('unresolvedReview.causePanelBridge')}
            </span>
          </span>
        )
      })}
    </span>
  )

  const iniAlerts: PageAlert[] = []
  if (editorMode === 'structured' && invalidIniSettings.length > 0) {
    iniAlerts.push({
      id: 'invalid-values',
      tone: 'error',
      title: t('invalidValuesAlert.title'),
      description: t('invalidValuesAlert.description', { settings: invalidIniSettings.map(getIniSettingLabel).join(listSep) }),
    })
  }
  if (luaChecksumCallout === 'localBlocked') {
    iniAlerts.push({
      id: 'lua-checksum',
      tone: 'error',
      title: t('iniTab.luaChecksumTitle'),
      description: <Trans i18nKey="iniTab.luaChecksumBody" t={t} components={{ 1: <strong /> }} />,
      action: { label: t('iniTab.disableNow'), onClick: () => updateIniValue('DoLuaChecksum', 'false') },
    })
  }
  if (initialDeepLink.unresolved.length > 0) {
    iniAlerts.push({
      id: 'unresolved-mods',
      tone: 'warning',
      title: t('unresolvedReview.title'),
      description: unresolvedModsList,
      action: { label: t('unresolvedReview.openActiveMods'), to: '/mods?view=active' },
    })
  }
  if (editorMode === 'structured' && outOfRangeIniSettings.length > 0) {
    iniAlerts.push({
      id: 'out-of-range',
      tone: 'warning',
      title: getSandboxOutOfRangeAllowedTitle(),
      description: getSandboxOutOfRangeAllowedBody(outOfRangeIniSettings.map(getIniSettingLabel).join(listSep)),
    })
  }
  if (luaChecksumCallout === 'workshopUnconfirmed') {
    iniAlerts.push({
      id: 'lua-checksum',
      tone: 'warning',
      title: t('iniTab.luaChecksumTitle'),
      description: t('iniTab.luaChecksumWorkshopUnconfirmed'),
      action: { label: t('iniTab.disableNow'), onClick: () => updateIniValue('DoLuaChecksum', 'false') },
    })
  }
  if (luaChecksumCallout === 'workshopNote') {
    iniAlerts.push({ id: 'lua-checksum', tone: 'info', title: t('iniTab.luaChecksumWorkshopNote') })
  }
  if (stopServerAlert) iniAlerts.push(stopServerAlert)

  const sandboxAlerts: PageAlert[] = []
  if (editorMode === 'structured' && invalidSandboxSettings.length > 0) {
    sandboxAlerts.push({
      id: 'invalid-values',
      tone: 'error',
      title: t('invalidValuesAlert.title'),
      description: t('invalidValuesAlert.description', { settings: invalidSandboxSettings.map(getSandboxSettingLabel).join(listSep) }),
    })
  }
  // Non-blocking: the sandboxRangeOverride toggle (Settings.tsx) let these
  // through invalidSandboxSettings above on purpose -- still surfaced so the
  // operator can SEE what's out of range ("warn, do not block").
  if (editorMode === 'structured' && outOfRangeSandboxSettings.length > 0) {
    sandboxAlerts.push({
      id: 'out-of-range',
      tone: 'warning',
      title: getSandboxOutOfRangeAllowedTitle(),
      description: getSandboxOutOfRangeAllowedBody(outOfRangeSandboxSettings.map(getSandboxSettingLabel).join(listSep)),
    })
  }
  if (worldSnapshotAlert) sandboxAlerts.push(worldSnapshotAlert)
  // Only once a load has genuinely failed (never while idle/loading), and it
  // never blocks the tab -- SANDBOX_SCHEMA's own table is still usable.
  if (sandboxLiveRangesStatus === 'unavailable') {
    sandboxAlerts.push({
      id: 'live-ranges',
      tone: 'info',
      title: getSandboxLiveRangesUnavailableTitle(),
      description: getSandboxLiveRangesUnavailableBody(),
      action: { label: t('modSettingsTab.retry'), onClick: () => { void loadModSettings() } },
    })
  }
  if (stopServerAlert) sandboxAlerts.push(stopServerAlert)

  const spawnAlerts: PageAlert[] = stopServerAlert ? [stopServerAlert] : []

  const modSettingsAlerts: PageAlert[] = []
  if (modSettingsError) {
    modSettingsAlerts.push({
      id: 'mod-settings-error',
      tone: modSettings ? 'warning' : 'error',
      title: modSettings ? t('modSettingsTab.refreshFailedTitle') : t('modSettingsTab.loadFailedTitle'),
      description: <span className="break-words">{modSettingsError}</span>,
      action: { label: t('modSettingsTab.retry'), onClick: () => { void loadModSettings() } },
    })
  }
  if (modSettings && modSettingsBridgeOutdated) {
    modSettingsAlerts.push({
      id: 'bridge-outdated',
      tone: 'warning',
      title: t('modSettingsTab.enumBridgeOutdatedTitle'),
      description: t('modSettingsTab.enumBridgeOutdatedDesc'),
      action: { label: t('unresolvedReview.openBridgeSettings'), to: '/settings?tab=bridge' },
    })
  }
  if (worldSnapshotAlert) modSettingsAlerts.push(worldSnapshotAlert)

  // ── Shared pieces of the file tabs ───────────────────────────────────────
  // Form / Raw: two toggle buttons (the switch asks before dropping edits).
  const editorModeToggle = (type: ConfigFileType, formLabel = t('editorToolbar.form')) => (
    <span className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5">
      <Button
        type="button"
        variant={editorMode === 'structured' ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => openFormEditor()}
        aria-pressed={editorMode === 'structured'}
        className="px-2.5"
      >
        <FormInput aria-hidden="true" /> {formLabel}
      </Button>
      <Button
        type="button"
        variant={editorMode === 'raw' ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => openRawEditor(type)}
        aria-pressed={editorMode === 'raw'}
        className="px-2.5"
      >
        <Code aria-hidden="true" /> {t('editorToolbar.raw')}
      </Button>
    </span>
  )

  const editorActions = (type: ConfigFileType, downloadLabel: string, link?: { href: string; label: string }) => (
    <>
      {editorModeToggle(type)}
      <Button variant="ghost" size="iconDense" onClick={() => handleCreateBackup(type)} aria-label={downloadLabel} title={downloadLabel}>
        <Download aria-hidden="true" />
      </Button>
      {link && (
        <a href={link.href} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          <ExternalLink aria-hidden="true" /> {link.label}
        </a>
      )}
    </>
  )

  const rawEditor = (heightClass: string) => (
    <div className="relative">
      <Button
        variant="outline"
        size="iconDense"
        className="absolute end-2 top-2 z-10"
        onClick={handleCopyRaw}
        aria-label={copied ? t('editorToolbar.copied') : t('editorToolbar.copyToClipboard')}
        title={copied ? t('editorToolbar.copied') : t('editorToolbar.copyToClipboard')}
      >
        {copied ? <Check className="text-primary" aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
      <Textarea
        value={rawContent}
        onChange={(e) => setRawContent(e.target.value)}
        className={cn('resize-y font-mono text-sm', heightClass)}
        spellCheck={false}
        dir="ltr"
      />
    </div>
  )

  // Search + All / Modified / Unsaved, shared by the INI and Sandbox forms.
  // "/" focuses the search (DESIGN.md keyboard rule).
  const settingsToolbar = (placeholder: string, ariaLabel: string) => (
    <Toolbar
      search={{
        value: searchQuery,
        onChange: (value) => setSearchQuery(value.slice(0, 128)),
        placeholder,
        ariaLabel,
        slashToFocus: true,
      }}
      end={
        <Segmented<FilterMode>
          value={filterMode}
          onValueChange={setFilterMode}
          ariaLabel={t('search.filterAria')}
          items={[
            { value: 'all', label: t('search.filterAll') },
            { value: 'modified', label: t('search.filterModified') },
            { value: 'nondefault', label: t('search.filterUnsaved') },
          ]}
        />
      }
    >
      {searchQuery && (
        <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {t('categoriesNav.matchCount', { count: searchResultsCount })}
        </span>
      )}
    </Toolbar>
  )

  const categoryHeading = (label: ReactNode, count: ReactNode, tone: 'default' | 'warning' = 'default') => (
    <div className={cn('mb-3 flex items-baseline justify-between gap-3 border-b pb-2', tone === 'warning' ? 'border-warning/30' : 'border-border/60')}>
      <h3 className={cn('text-sm font-semibold', tone === 'warning' ? 'text-warning' : 'text-foreground')}>{label}</h3>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
    </div>
  )

  const emptyCategory = (
    <p className="py-10 text-center text-sm text-muted-foreground">
      {filterMode === 'modified' ? t('categoryContent.noneModified') :
       filterMode === 'nondefault' ? t('categoryContent.noneUnsaved') :
       t('categoryContent.none')}
    </p>
  )

  const noSearchMatches = (
    <p className="py-10 text-center text-sm text-muted-foreground">
      {t('search.noMatches', { query: searchQuery })}
    </p>
  )

  const renderIniRow = (setting: IniSetting) => (
    <IniSettingRow
      key={setting.key}
      setting={setting}
      value={iniSettings[setting.key] || ''}
      originalValue={originalIniSettings[setting.key]}
      onChange={updateIniValue}
      onReset={resetIniValue}
      onBrowse={openFileBrowser}
      allowOutOfRange={allowOutOfRangeSandbox}
      misnamedAs={iniMisnamedKeys[setting.key]}
      misnamedFileValue={iniMisnamedValues[setting.key]}
      secretCutAtEquals={iniMaskedCutAtEqualsKeys.includes(setting.key)}
    />
  )

  const renderSandboxRow = (setting: SandboxSetting) => (
    <SandboxSettingRow
      key={`${setting.section || 'settings'}.${setting.key}`}
      setting={setting}
      value={(sandboxData?.[(setting.section || 'settings') as keyof SandboxData] as SandboxRecord)?.[setting.key]}
      originalValue={(originalSandboxData?.[(setting.section || 'settings') as keyof SandboxData] as SandboxRecord)?.[setting.key]}
      onChange={updateSandboxValue}
      onReset={resetSandboxValue}
      allowOutOfRange={allowOutOfRangeSandbox}
    />
  )

  const categoryCount = (count: number) => (
    <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
  )

  // The category rails: one SubNav each (a select below lg). A group whose
  // categories are all empty under the current filter leaves the rail.
  const iniNavGroups: SubNavGroup[] = [
    ...INI_CATEGORY_GROUPS.map((group) => ({
      id: group.id,
      label: getIniCategoryGroupLabel(group),
      items: INI_CATEGORIES
        .filter((category) => category.group === group.id)
        .filter((category) => filterMode === 'all' || (filteredIniSettings[category.id] || []).length > 0)
        .map((category) => ({
          id: category.id,
          label: getIniCategoryLabel(category),
          icon: categoryIcon(category.icon),
          dirty: (iniModifiedByCategory[category.id] || 0) > 0,
          badge: categoryCount((filteredIniSettings[category.id] || []).length),
        })),
    })).filter((group) => group.items.length > 0),
    ...(uncategorizedIniKeys.length > 0
      ? [{
          id: 'uncategorized',
          items: [{
            id: 'uncategorized',
            label: t('categoriesNav.uncategorizedIniLabel'),
            icon: HelpCircle,
            tone: 'warning' as const,
            badge: categoryCount(uncategorizedIniKeys.length),
          }],
        }]
      : []),
  ]

  const sandboxNavGroups: SubNavGroup[] = [
    ...SANDBOX_CATEGORY_GROUPS.map((group) => ({
      id: group.id,
      label: getSandboxCategoryGroupLabel(group),
      items: SANDBOX_CATEGORIES
        .filter((category) => category.group === group.id)
        .filter((category) => filterMode === 'all' || (filteredSandboxSettings[category.id] || []).length > 0)
        .map((category) => ({
          id: category.id,
          label: getSandboxCategoryLabel(category),
          icon: categoryIcon(category.icon),
          dirty: (sandboxModifiedByCategory[category.id] || 0) > 0,
          badge: categoryCount((filteredSandboxSettings[category.id] || []).length),
        })),
    })).filter((group) => group.items.length > 0),
    ...(uncategorizedSandboxKeys.length > 0
      ? [{
          id: 'uncategorized',
          items: [{
            id: 'uncategorized',
            label: t('categoriesNav.uncategorizedSandboxLabel'),
            icon: HelpCircle,
            tone: 'warning' as const,
            badge: categoryCount(uncategorizedSandboxKeys.length),
          }],
        }]
      : []),
  ]

  const iniCategoryContent = () => {
    if (activeIniCategory === 'uncategorized') {
      if (uncategorizedIniKeys.length === 0) {
        return <p className="py-10 text-center text-sm text-muted-foreground">{t('uncategorizedIni.empty')}</p>
      }
      return (
        <div>
          {categoryHeading(t('uncategorizedIni.heading'), t('uncategorizedIni.keyCount', { count: uncategorizedIniKeys.length }), 'warning')}
          <p className="mb-3 text-xs text-muted-foreground">{t('uncategorizedIni.description')}</p>
          <div className="space-y-1">
            {uncategorizedIniKeys.map(({ key, value }) => {
              const orig = originalIniSettings[key]
              const isModified = orig !== undefined && orig !== value
              return (
                <div key={key} className={cn('flex flex-wrap items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors', isModified ? 'border border-warning/20 bg-warning/10' : 'hover:bg-muted/50')}>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate font-mono text-sm" title={key}>{key}</span>
                    {isModified && (
                      <Button
                        variant="ghost"
                        size="iconDense"
                        className="text-warning hover:text-warning"
                        onClick={() => setIniSettings(prev => ({ ...prev, [key]: orig ?? '' }))}
                        title={t('uncategorizedIni.undoTitle')}
                        aria-label={t('uncategorizedIni.undoTitle')}
                      >
                        <Undo2 aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                  <Input
                    className="h-9 w-full text-sm sm:w-56"
                    value={value}
                    maxLength={500}
                    aria-label={key}
                    onChange={e => setIniSettings(prev => ({ ...prev, [key]: e.target.value }))}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )
    }
    const settings = filteredIniSettings[activeIniCategory] || []
    const active = INI_CATEGORIES.find(c => c.id === activeIniCategory)
    if (settings.length === 0) return emptyCategory
    return (
      <div>
        {categoryHeading(active ? getIniCategoryLabel(active) : null, t('categoryContent.settingCount', { count: settings.length }))}
        <div className="space-y-1">{settings.map(renderIniRow)}</div>
      </div>
    )
  }

  const sandboxCategoryContent = () => {
    if (activeSandboxCategory === 'uncategorized') {
      if (uncategorizedSandboxKeys.length === 0) {
        return <p className="py-10 text-center text-sm text-muted-foreground">{t('uncategorizedSandbox.empty')}</p>
      }
      return (
        <div>
          {categoryHeading(t('uncategorizedSandbox.heading'), t('uncategorizedSandbox.keyCount', { count: uncategorizedSandboxKeys.length }), 'warning')}
          <p className="mb-3 text-xs text-muted-foreground">{t('uncategorizedSandbox.description')}</p>
          <div className="space-y-5">
            {Object.entries(uncategorizedGroups).map(([groupName, groupEntries]) => (
              <div key={groupName}>
                <div className="mb-1.5 flex items-baseline justify-between border-b border-border/40 pb-1">
                  <h4 className={cn('text-xs font-semibold text-muted-foreground', groupName !== 'settings' && 'font-mono')}>
                    {groupName === 'settings' ? t('uncategorizedSandbox.mainSection') : groupName}
                  </h4>
                  <span className="text-xs tabular-nums text-muted-foreground">{groupEntries.length}</span>
                </div>
                <div className="space-y-1">
                  {groupEntries.map(({ section, key, value }) => {
                    const origSection = originalSandboxData?.[section as keyof SandboxData]
                    const origValue = typeof origSection === 'object' ? (origSection as Record<string, unknown>)?.[key] : undefined
                    const isModified = value !== origValue
                    return (
                      <div key={`${section}.${key}`} className={cn('flex flex-wrap items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors', isModified ? 'border border-warning/20 bg-warning/10' : 'hover:bg-muted/50')}>
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="truncate font-mono text-sm" title={key}>{key}</span>
                          {isModified && (
                            <Button
                              variant="ghost"
                              size="iconDense"
                              className="text-warning hover:text-warning"
                              onClick={() => {
                                if (origValue !== undefined) {
                                  setSandboxData(prev => {
                                    if (!prev) return prev
                                    const s = { ...(prev[section as keyof SandboxData] as Record<string, unknown> || {}) }
                                    s[key] = origValue
                                    return { ...prev, [section]: s } as SandboxData
                                  })
                                }
                              }}
                              title={t('uncategorizedSandbox.undoTitle')}
                              aria-label={t('uncategorizedSandbox.undoTitle')}
                            >
                              <Undo2 aria-hidden="true" />
                            </Button>
                          )}
                        </div>
                        <Input
                          className="h-9 w-full shrink-0 text-sm sm:w-48"
                          value={String(value)}
                          maxLength={500}
                          aria-label={key}
                          onChange={e => {
                            const raw = e.target.value
                            let parsed: string | number | boolean = raw
                            if (raw === 'true') parsed = true
                            else if (raw === 'false') parsed = false
                            else if (raw !== '' && !isNaN(Number(raw))) parsed = Number(raw)
                            setSandboxData(prev => {
                              if (!prev) return prev
                              const s = { ...(prev[section as keyof SandboxData] as Record<string, unknown> || {}) }
                              s[key] = parsed
                              return { ...prev, [section]: s } as SandboxData
                            })
                          }}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )
    }
    const settings = filteredSandboxSettings[activeSandboxCategory] || []
    const active = SANDBOX_CATEGORIES.find(c => c.id === activeSandboxCategory)
    if (settings.length === 0) return emptyCategory
    return (
      <div>
        {categoryHeading(active ? getSandboxCategoryLabel(active) : null, t('categoryContent.settingCount', { count: settings.length }))}
        <div className="space-y-1">{settings.map(renderSandboxRow)}</div>
      </div>
    )
  }

  const tabDefs = [
    // pathsInfo is null both for a genuinely-unconfigured panel (where
    // "missing" is correct -- there is no file) and for a remote server with
    // no SFTP transport set up (loadData), where nothing is actually
    // confirmed missing, only unreachable. The load alert already explains
    // the remote case -- don't also claim these two files are missing.
    { value: 'ini', label: t('tabs.serverSettings'), icon: Settings, dirty: hasIniChanges, count: changedIniCount, missing: !activeServerRemote && !pathsInfo?.exists.ini },
    { value: 'sandbox', label: t('tabs.sandbox'), icon: FileText, dirty: hasSandboxChanges, count: changedSandboxCount, missing: !activeServerRemote && !pathsInfo?.exists.sandbox },
    { value: 'spawnpoints', label: t('tabs.spawnPoints'), icon: MapPin, dirty: hasSpawnPointChanges, count: 0, missing: false },
    { value: 'spawnregions', label: t('tabs.spawnRegions'), icon: Map, dirty: hasSpawnRegionChanges, count: 0, missing: false },
    { value: 'modsettings', label: t('tabs.modSettings'), icon: Puzzle, dirty: false, count: modifiedModSettingsCount, missing: false },
  ] as const

  return (
    <div className="space-y-6 page-transition">
      {header}
      <PageAlerts alerts={pageAlerts} />

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
        {/* One row that scrolls sideways on a phone instead of wrapping
            into a block of buttons above the content. */}
        <TabsList ref={tabListRef} aria-label={t('tabs.listAria')} className="nav-scroll flex h-auto w-full justify-start gap-1 overflow-x-auto">
          {tabDefs.map((tabDef) => (
            <TabsTrigger key={tabDef.value} value={tabDef.value} className="shrink-0 gap-2">
              <tabDef.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {tabDef.label}
              {tabDef.count > 0 && (
                <span className="rounded-full border border-warning/30 bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums text-warning">
                  {tabDef.count}
                </span>
              )}
              {tabDef.dirty && activeTab !== tabDef.value && (
                <span role="img" className="h-1.5 w-1.5 rounded-full bg-warning" aria-label={t('tabs.unsavedChangesAria')} />
              )}
              {tabDef.missing && (
                <AlertCircle className="h-4 w-4 text-warning" aria-label={t('tabs.fileMissingAria')} />
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* INI Settings Tab */}
        <TabsContent value="ini" className="mt-0 space-y-4">
          <PageAlerts alerts={iniAlerts} />
          <SectionCard
            title={t('iniTab.sectionLabel')}
            description={t('iniTab.sectionSublabel')}
            icon={FileText}
            actions={editorActions('ini', t('editorToolbar.downloadIniAria'), { href: 'https://pzwiki.net/wiki/Server_settings', label: t('editorToolbar.wiki') })}
          >
            {editorMode === 'raw' ? rawEditor('h-[calc(100dvh-380px)] min-h-[400px]') : (
              <div className="space-y-4">
                {settingsToolbar(t('search.settingsPlaceholder'), t('search.aria'))}
                {searchQuery ? (
                  // Search: flat results across every category, grouped by category.
                  <div className="space-y-6">
                    {INI_CATEGORIES.map(category => {
                      const settings = filteredIniSettings[category.id] || []
                      if (settings.length === 0) return null
                      return (
                        <div key={category.id}>
                          {categoryHeading(getIniCategoryLabel(category), t('categoriesNav.matchCount', { count: settings.length }))}
                          <div className="space-y-1">{settings.map(renderIniRow)}</div>
                        </div>
                      )
                    })}
                    {searchResultsCount === 0 && noSearchMatches}
                  </div>
                ) : (
                  <SubNavLayout
                    nav={
                      <SubNav
                        kind="nav"
                        groups={iniNavGroups}
                        value={activeIniCategory}
                        onValueChange={setActiveIniCategory}
                        ariaLabel={t('categoriesNav.iniAria')}
                      />
                    }
                  >
                    {iniCategoryContent()}
                  </SubNavLayout>
                )}
              </div>
            )}
          </SectionCard>
        </TabsContent>

        {/* Sandbox Tab */}
        <TabsContent value="sandbox" className="mt-0 space-y-4">
          <PageAlerts alerts={sandboxAlerts} />
          <SectionCard
            title={t('sandboxTab.sectionLabel')}
            description={t('sandboxTab.build42Body')}
            icon={Code}
            actions={editorActions('sandbox', t('editorToolbar.downloadSandboxAria'), { href: 'https://pzwiki.net/wiki/Sandbox_options', label: t('editorToolbar.wiki') })}
          >
            {editorMode === 'raw' ? rawEditor('h-[calc(100dvh-380px)] min-h-[400px]') : (
              <div className="space-y-4">
                {settingsToolbar(t('search.sandboxPlaceholder'), t('search.sandboxAria'))}
                {searchQuery ? (
                  <div className="space-y-6">
                    {SANDBOX_CATEGORIES.map(category => {
                      const settings = filteredSandboxSettings[category.id] || []
                      if (settings.length === 0) return null
                      return (
                        <div key={category.id}>
                          {categoryHeading(getSandboxCategoryLabel(category), t('categoriesNav.matchCount', { count: settings.length }))}
                          <div className="space-y-1">{settings.map(renderSandboxRow)}</div>
                        </div>
                      )
                    })}
                    {searchResultsCount === 0 && noSearchMatches}
                  </div>
                ) : (
                  <SubNavLayout
                    nav={
                      <SubNav
                        kind="nav"
                        groups={sandboxNavGroups}
                        value={activeSandboxCategory}
                        onValueChange={setActiveSandboxCategory}
                        ariaLabel={t('categoriesNav.sandboxAria')}
                      />
                    }
                  >
                    {sandboxCategoryContent()}
                  </SubNavLayout>
                )}
              </div>
            )}
          </SectionCard>
        </TabsContent>

        {/* Spawn Points Tab */}
        <TabsContent value="spawnpoints" className="mt-0 space-y-4">
          <PageAlerts alerts={spawnAlerts} />
          <SectionCard
            title={t('spawnPointsTab.sectionLabel')}
            description={t('spawnPointsTab.sectionSublabel')}
            icon={MapPin}
            actions={editorActions('spawnpoints', t('editorToolbar.downloadSpawnPointsAria'), { href: 'https://map.projectzomboid.com/', label: t('editorToolbar.map') })}
          >
            {editorMode === 'raw' ? rawEditor('h-[400px]') : (
              <div className="flex flex-col items-center py-10 text-center">
                <span className="mb-4 grid h-12 w-12 place-items-center rounded-full border border-primary/20 bg-primary/10 text-primary">
                  <MapPin className="h-6 w-6" aria-hidden="true" />
                </span>
                <h3 className="text-base font-semibold text-foreground">{t('spawnPointsTab.modManagedTitle')}</h3>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  <Trans i18nKey="spawnPointsTab.modManagedBody" t={t} components={{ 1: <strong /> }} />
                </p>
                <Button variant="outline" size="sm" className="mt-5" onClick={() => openRawEditor('spawnpoints')}>
                  <Code aria-hidden="true" /> {t('spawnPointsTab.openRawFile')}
                </Button>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        {/* Spawn Regions Tab */}
        <TabsContent value="spawnregions" className="mt-0 space-y-4">
          <PageAlerts alerts={spawnAlerts} />
          <SectionCard
            title={t('spawnRegionsTab.sectionLabel')}
            description={t('spawnRegionsTab.sectionSublabel', { count: spawnRegions.length })}
            icon={Map}
            actions={editorActions('spawnregions', t('editorToolbar.downloadSpawnRegionsAria'))}
          >
            {editorMode === 'raw' ? rawEditor('h-[400px]') : (
              <div className="space-y-3">
                {spawnRegions.length === 0 ? (
                  <EmptyState type="noData" title={t('spawnRegionsTab.noRegionsTitle')} description={t('spawnRegionsTab.noRegionsDesc')} compact />
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border/60">
                    {/* Column headers (sm+ only) */}
                    <div className="hidden grid-cols-[2rem_minmax(180px,260px)_minmax(0,1fr)_2.25rem] items-center gap-3 border-b border-border/60 bg-muted/30 px-3 py-2 sm:grid">
                      <span className="label-micro text-center">#</span>
                      <span className="label-micro">{t('spawnRegionsTab.columnDisplayName')}</span>
                      <span className="label-micro flex items-center gap-1">
                        {t('spawnRegionsTab.columnMapFilePath')}
                        <HelpTip label={t('spawnRegionsTab.columnMapFilePath')}>{t('spawnRegionsTab.mapFilePathTip')}</HelpTip>
                      </span>
                      <span aria-hidden="true" />
                    </div>
                    <ul className="divide-y divide-border/60">
                      {spawnRegions.map((region, index) => (
                        <li
                          key={index}
                          className="grid grid-cols-1 gap-3 px-3 py-2.5 sm:grid-cols-[2rem_minmax(180px,260px)_minmax(0,1fr)_2.25rem] sm:items-center"
                        >
                          <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border bg-muted/40 px-1.5 text-xs font-medium tabular-nums text-muted-foreground sm:justify-self-center">
                            {index + 1}
                          </span>
                          <div className="min-w-0">
                            <Label className="label-micro sm:sr-only">{t('spawnRegionsTab.columnDisplayName')}</Label>
                            <Input
                              value={region.name}
                              onChange={(e) => {
                                const newRegions = [...spawnRegions]
                                newRegions[index] = { ...region, name: e.target.value }
                                setSpawnRegions(newRegions)
                              }}
                              placeholder={t('spawnRegionsTab.displayNamePlaceholder')}
                              maxLength={64}
                              className="mt-0.5 h-9 sm:mt-0"
                              aria-label={t('spawnRegionsTab.displayNameAria', { index: index + 1 })}
                            />
                          </div>
                          <div className="min-w-0">
                            <Label className="label-micro flex items-center gap-2 sm:sr-only">
                              {region.isServerFile ? t('spawnRegionsTab.serverFileLabel') : t('spawnRegionsTab.columnMapFilePath')}
                              {region.isServerFile && (
                                <Badge variant="secondary" className="py-0 text-[10px]">{t('spawnRegionsTab.serverFileBadge')}</Badge>
                              )}
                            </Label>
                            <div className="relative mt-0.5 sm:mt-0">
                              <Input
                                value={region.file}
                                onChange={(e) => {
                                  const newRegions = [...spawnRegions]
                                  newRegions[index] = { ...region, file: e.target.value }
                                  setSpawnRegions(newRegions)
                                }}
                                placeholder={region.isServerFile ? t('spawnRegionsTab.serverFilePlaceholder') : t('spawnRegionsTab.mapFilePlaceholder')}
                                className={cn('h-9 font-mono text-xs', region.isServerFile && 'pe-20')}
                                maxLength={512}
                                dir="ltr"
                                aria-label={region.isServerFile ? t('spawnRegionsTab.fileAriaServerFile', { index: index + 1 }) : t('spawnRegionsTab.fileAriaMapPath', { index: index + 1 })}
                              />
                              {region.isServerFile && (
                                <Badge variant="secondary" className="absolute end-1.5 top-1/2 -translate-y-1/2 py-0 text-[10px]">
                                  {t('spawnRegionsTab.serverFileBadge')}
                                </Badge>
                              )}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="justify-self-end text-muted-foreground hover:text-destructive sm:justify-self-center"
                            onClick={() => setSpawnRegions(spawnRegions.filter((_, i) => i !== index))}
                            aria-label={t('spawnRegionsTab.deleteAria', { name: region.name || index + 1 })}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex justify-end pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSpawnRegions([...spawnRegions, { name: '', file: 'media/maps/' }])}
                  >
                    <Plus aria-hidden="true" /> {t('spawnRegionsTab.addRegion')}
                  </Button>
                </div>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        {/* Mod Settings Tab (Live from PanelBridge) */}
        <TabsContent value="modsettings" className="mt-0 space-y-4">
          <PageAlerts alerts={modSettingsAlerts} />
          <SectionCard
            title={t('modSettingsTab.sectionLabel')}
            description={modSettings ? t('modSettingsTab.sectionSublabelLoaded', { count: modSettingsGroups.length }) : t('modSettingsTab.sectionSublabelIdle')}
            icon={Puzzle}
            status={modifiedModSettingsCount > 0 ? (
              <StatusPill tone="warn" size="sm" label={t('modSettingsTab.modifiedBadge', { count: modifiedModSettingsCount })} title={t('modSettingsTab.modifiedBadgeTitle')} />
            ) : undefined}
            actions={
              <>
                {/* The mods these options come from are managed on the Mods page. */}
                <Link to="/mods?view=active" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                  <Package aria-hidden="true" /> {t('modSettingsTab.manageMods')}
                </Link>
                <Button
                  variant={modSettings ? 'outline' : 'command'}
                  size="sm"
                  onClick={loadModSettings}
                  disabled={modSettingsLoading}
                >
                  {modSettingsLoading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                  {modSettings ? t('modSettingsTab.refresh') : t('modSettingsTab.load')}
                </Button>
              </>
            }
          >
            {modSettings && modSettingsGroups.length > 0 && (
              <Toolbar
                search={{
                  value: modSettingsSearch,
                  onChange: (value) => setModSettingsSearch(value.slice(0, 200)),
                  placeholder: t('modSettingsTab.searchPlaceholder'),
                  ariaLabel: t('modSettingsTab.searchPlaceholder'),
                  slashToFocus: true,
                }}
                end={
                  <>
                    <DisabledReason reason={modifiedModSettingsCount === 0 && !modSettingsModifiedOnly ? t('modSettingsTab.modifiedFilterNoneTitle') : null}>
                      <Button
                        variant={modSettingsModifiedOnly ? 'secondary' : 'outline'}
                        size="sm"
                        onClick={() => setModSettingsModifiedOnly(v => !v)}
                        disabled={modifiedModSettingsCount === 0 && !modSettingsModifiedOnly}
                        aria-pressed={modSettingsModifiedOnly}
                        // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27: the disabled-reason branch (no modified options) now lives in the DisabledReason wrapper above; this title carries only the enabled-state hint.
                        title={t('modSettingsTab.modifiedFilterTitle')}
                      >
                        <Filter aria-hidden="true" />
                        {t('modSettingsTab.modifiedFilter')}
                        {modifiedModSettingsCount > 0 && (
                          <span className="rounded-full bg-warning/15 px-1.5 text-[10px] font-medium tabular-nums text-warning">
                            {modifiedModSettingsCount}
                          </span>
                        )}
                      </Button>
                    </DisabledReason>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const allVisible = filteredModGroups.length > 0 && filteredModGroups.every(g => expandedModGroups.has(g.name))
                        if (allVisible) {
                          setExpandedModGroups(new Set())
                        } else {
                          setExpandedModGroups(new Set(filteredModGroups.map(g => g.name)))
                        }
                      }}
                    >
                      {filteredModGroups.length > 0 && filteredModGroups.every(g => expandedModGroups.has(g.name)) ? (
                        <><ChevronDown aria-hidden="true" /> {t('modSettingsTab.collapseAll')}</>
                      ) : (
                        <><ChevronRight className="rtl:-scale-x-100" aria-hidden="true" /> {t('modSettingsTab.expandAll')}</>
                      )}
                    </Button>
                  </>
                }
              />
            )}
            {!modSettings && !modSettingsLoading && !modSettingsError && (
              <EmptyState
                type="noMods"
                title={t('modSettingsTab.notLoadedTitle')}
                description={
                  <span>
                    {t('modSettingsTab.notLoadedDescPrefix')}
                    <HelpTip label={t('modSettingsTab.panelBridgeLabel')} side="bottom" className="mx-1 align-[-2px]">
                      {t('modSettingsTab.panelBridgeTip')}
                    </HelpTip>
                    {t('modSettingsTab.notLoadedDescSuffix')}
                  </span>
                }
              />
            )}

            {modSettingsLoading && (
              <div className="flex items-center justify-center gap-3 py-12 text-sm text-muted-foreground" role="status">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                <span>{t('modSettingsTab.loadingOptions')}</span>
              </div>
            )}

            {modSettings && modSettingsGroups.length === 0 && !modSettingsLoading && (
              <EmptyState
                type="noMods"
                title={t('modSettingsTab.noOptionsTitle')}
                description={t('modSettingsTab.noOptionsDesc')}
              />
            )}

            {modSettings && modSettingsGroups.length > 0 && (
              <div>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Badge variant="secondary">
                    {/* bug-hunt-2026-09-08 (Arabic render pass, dwight): same
                        "number / number" bidi-neutral-run reversal as
                        6a6e26ee/09040e60/Debug.tsx -- confirmed with a real
                        Chromium render (not assumed): the internal digit
                        pair reverses here too once it sits next to the
                        Arabic label text. <bdi> isolates it. */}
                    {modSettingsSearch || modSettingsModifiedOnly ? <bdi>{`${filteredModGroups.length} / ${modSettingsGroups.length}`}</bdi> : modSettingsGroups.length} {t('modSettingsTab.groupsBadge')}
                  </Badge>
                  <Badge variant="secondary">
                    {modSettingsSearch || modSettingsModifiedOnly
                      ? <bdi>{`${filteredModGroups.reduce((s, g) => s + g.filteredOpts.length, 0)} / ${modSettingsGroups.reduce((s, g) => s + g.count, 0)}`}</bdi>
                      : modSettingsGroups.reduce((s, g) => s + g.count, 0)
                    } {t('modSettingsTab.optionsBadge')}
                  </Badge>
                  {modSettingsLastLoaded && (
                    <span className="ms-auto text-xs text-muted-foreground">
                      {t('modSettingsTab.loadedAt', { time: formatTime(modSettingsLastLoaded, { seconds: true }) })}
                    </span>
                  )}
                </div>
                {filteredModGroups
                  .map(group => {
                    // When the user is actively filtering, force groups open so matches
                    // are immediately visible (otherwise hits hide behind collapsed headers).
                    const isFiltering = !!modSettingsSearch.trim() || modSettingsModifiedOnly
                    const isExpanded = isFiltering || expandedModGroups.has(group.name)
                    const filteredOpts = group.filteredOpts
                    // Modified count for this whole group (not just visible/filtered)
                    const groupAllOpts = modSettings[group.name] || []
                    const groupModifiedCount = groupAllOpts.reduce((c, o) => c + (isOptModified(o) ? 1 : 0), 0)

                    return (
                      <div key={group.name} className="mb-2">
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedModGroups(prev => {
                              const next = new Set(prev)
                              if (next.has(group.name)) next.delete(group.name)
                              else next.add(group.name)
                              return next
                            })
                          }}
                          aria-expanded={isExpanded}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
                            isExpanded ? 'border-primary/30 bg-primary/10' : 'border-border/60 bg-muted/30 hover:bg-muted/60',
                          )}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground rtl:-scale-x-100" aria-hidden="true" />
                          )}
                          <span className="min-w-0 truncate font-medium" title={formatModSettingLabel(group.name)}>{formatModSettingLabel(group.name)}</span>
                          {groupModifiedCount > 0 && (
                            <Badge variant="warning" className="h-5 shrink-0 px-1.5 py-0 text-[10px]" title={t('modSettingsTab.groupModifiedTitle', { count: groupModifiedCount })}>
                              {t('modSettingsTab.groupModifiedBadge', { count: groupModifiedCount })}
                            </Badge>
                          )}
                          <span className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                            {filteredOpts.length}
                          </span>
                        </button>
                        {isExpanded && (
                          <div className="mt-2 space-y-1 ps-4 sm:ps-7">
                            {filteredOpts.map((opt, idx) => {
                              // Mods often expose an internal sandbox key as their
                              // "translated" name. Format it before displaying it.
                              const rawDisplayName = opt.shortName || opt.name || `Option ${idx}`
                              const displayName = formatModSettingLabel(
                                opt.translatedName && opt.translatedName !== rawDisplayName ? opt.translatedName : rawDisplayName,
                                group.name,
                              ) || `Option ${idx + 1}`
                              // Keep player-facing help, but hide untranslated tooltip keys.
                              const rawTooltip = opt.tooltipText || opt.tooltip || ''
                              const description = formatModSettingDescription(rawTooltip.replace(/\n?Default\s*=\s*.*/i, ''))
                              const rawVal = opt.value
                              let displayValue: string
                              if (rawVal === undefined || rawVal === null) {
                                displayValue = '—'
                              } else if (typeof rawVal === 'number') {
                                displayValue = Number.isInteger(rawVal) ? String(rawVal) : rawVal.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
                              } else {
                                displayValue = String(rawVal)
                              }
                              const typeLabel = opt.type || 'unknown'
                              const boolValue = typeLabel === 'boolean'
                                ? (rawVal === true || rawVal === 'true' || rawVal === 1)
                                : false
                              const isSaving = opt.name ? savingOptions.has(opt.name) : false
                              const isModified = isOptModified(opt)
                              // A list only when its labels line up with the values;
                              // otherwise the choice's number (describeModEnumControl).
                              const enumControl = describeModEnumControl(opt)
                              const enumAsNumber = enumControl !== null && enumControl.listLabels === null
                              const blockedEnumValue = enumControl?.blockedValue ?? null
                              const enumHintId = blockedEnumValue !== null || enumControl?.tooManyToList
                                ? `mod-enum-hint-${(opt.name || `${group.name}-${idx}`).replace(/\s+/g, '_')}`
                                : undefined

                              return (
                                <div
                                  key={`${opt.name || 'opt'}-${idx}`}
                                  className={cn('flex flex-col gap-2 rounded-md px-3 py-2 hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between sm:gap-4', isSaving && 'pointer-events-none opacity-60')}
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium" title={opt.name || displayName}>
                                      {displayName}
                                    </div>
                                    {description && (
                                      <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" title={rawTooltip}>
                                        {description}
                                      </div>
                                    )}
                                    {opt.name && opt.name !== displayName && (
                                      <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground/70" title={opt.name} dir="ltr">{opt.name}</div>
                                    )}
                                    {blockedEnumValue !== null ? (
                                      <div id={enumHintId} className="mt-0.5 text-xs text-warning">
                                        {t('modSettingsTab.enumLastChoiceHeldBack', { max: blockedEnumValue })}
                                      </div>
                                    ) : enumControl?.tooManyToList ? (
                                      <div id={enumHintId} className="mt-0.5 text-xs text-muted-foreground">
                                        {t('modSettingsTab.enumTooManyChoices')}
                                      </div>
                                    ) : null}
                                  </div>
                                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                                    {typeLabel === 'boolean' ? (
                                      <div className="flex items-center gap-2">
                                        <Switch
                                          checked={boolValue}
                                          onCheckedChange={(checked) => opt.name && !isSaving && handleOptionChange(opt.name, checked, group.name)}
                                          disabled={isSaving}
                                          aria-label={t('modSettingsTab.toggleAria', { label: displayName, state: boolValue ? t('modSettingsTab.onCaps') : t('modSettingsTab.offCaps') })}
                                        />
                                        <span className={cn('text-xs', boolValue ? 'text-primary' : 'text-muted-foreground')}>
                                          {boolValue ? t('row.on') : t('row.off')}
                                        </span>
                                      </div>
                                    ) : enumControl?.listLabels ? (
                                      <Select
                                        value={opt.selectedIndex !== undefined ? String(opt.selectedIndex) : displayValue}
                                        onValueChange={(val) => {
                                          if (!opt.name || isSaving) return
                                          const idx = parseInt(val, 10)
                                          if (isNaN(idx)) return
                                          // The item is disabled too; this keeps all three paths on one guard.
                                          if (idx === blockedEnumValue) {
                                            refuseBlockedEnumValue(opt.name, idx)
                                            return
                                          }
                                          handleOptionChange(opt.name, idx, group.name)
                                        }}
                                        disabled={isSaving}
                                      >
                                        <SelectTrigger
                                          className="h-9 w-full text-xs sm:w-[180px]"
                                          aria-label={displayName}
                                          aria-describedby={enumHintId}
                                        >
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {enumControl.listLabels.map((ev, ei) => (
                                            <SelectItem key={ei} value={String(ei + 1)} className="text-xs">
                                              {ev}
                                            </SelectItem>
                                          ))}
                                          {/* The old bridge never read the last label, and would save this value as
                                              the one before it. The label stays neutral: it is also what the trigger
                                              shows when the option already holds this value. */}
                                          {blockedEnumValue !== null && (
                                            <SelectItem value={String(blockedEnumValue)} disabled className="text-xs">
                                              {t('modSettingsTab.enumLastChoiceItem', { value: blockedEnumValue })}
                                            </SelectItem>
                                          )}
                                        </SelectContent>
                                      </Select>
                                    ) : typeLabel === 'number' || typeLabel === 'double' || typeLabel === 'integer' || enumAsNumber ? (
                                      <Input
                                        key={`${opt.name}-${displayValue}`}
                                        type="number"
                                        className="h-9 w-full text-end text-xs tabular-nums sm:w-[100px]"
                                        defaultValue={displayValue}
                                        min={opt.min}
                                        max={opt.max}
                                        // The browser counts valid values up from `min` in `step`
                                        // increments, so a fractional min like 0.001 with step 1
                                        // rejects every whole number the user types.
                                        step={(typeLabel === 'integer' || enumAsNumber) && Number.isInteger(opt.min ?? 0) ? 1 : 'any'}
                                        disabled={isSaving}
                                        aria-label={displayName}
                                        aria-describedby={enumHintId}
                                        onWheel={(e) => e.currentTarget.blur()}
                                        onBlur={(e) => {
                                          let num = parseFloat(e.target.value)
                                          if (isNaN(num) || !opt.name) return
                                          if (opt.min !== undefined) num = Math.max(opt.min, num)
                                          if (opt.max !== undefined) num = Math.min(opt.max, num)
                                          if (num === rawVal) return
                                          if (num === blockedEnumValue) {
                                            e.target.value = displayValue
                                            refuseBlockedEnumValue(opt.name, num)
                                            return
                                          }
                                          e.target.value = String(num)
                                          handleOptionChange(opt.name, num, group.name)
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            (e.target as HTMLInputElement).blur()
                                          }
                                        }}
                                      />
                                    ) : (
                                      <Input
                                        key={`${opt.name}-${displayValue}`}
                                        type="text"
                                        className="h-9 w-full text-xs sm:w-[160px]"
                                        defaultValue={displayValue}
                                        disabled={isSaving}
                                        aria-label={displayName}
                                        onBlur={(e) => {
                                          if (e.target.value !== String(rawVal) && opt.name) {
                                            handleOptionChange(opt.name, e.target.value, group.name)
                                          }
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            (e.target as HTMLInputElement).blur()
                                          }
                                        }}
                                      />
                                    )}
                                    {opt.min !== undefined && opt.max !== undefined && (
                                      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                                        <bdi>{opt.min}–{opt.max}</bdi>
                                      </span>
                                    )}
                                    {isModified && (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <button
                                            type="button"
                                            className="flex items-center gap-1 whitespace-nowrap rounded text-xs text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                                            onClick={() => {
                                              if (!opt.name || opt.default === undefined) return
                                              if (blockedEnumValue !== null && opt.default === blockedEnumValue) {
                                                refuseBlockedEnumValue(opt.name, blockedEnumValue)
                                                return
                                              }
                                              handleOptionChange(opt.name, opt.default, group.name)
                                            }}
                                            disabled={isSaving}
                                            // eslint-disable-next-line local/no-dead-disabled-title -- pure hint naming the action + value; disables only transiently while a save is in flight (the adjacent spinner is the self-evident why). Triaged 2026-08-27. Note: the wrapping Radix Tooltip here has the same "no pointer/focus events on a disabled native button" limitation as this title, so its content is equally unreachable while isSaving -- out of scope for this rule (it only checks title+disabled), flagged here rather than fixed since isSaving is brief and self-evident.
                                            title={t('modSettingsTab.resetToDefaultTitle', { value: formatRawConfigValue(opt.default) })}
                                          >
                                            <Undo2 className="h-3 w-3" aria-hidden="true" />
                                            <span>{t('modSettingsTab.resetToDefaultLabel', { value: formatRawConfigValue(opt.default) })}</span>
                                          </button>
                                        </TooltipTrigger>
                                        <TooltipContent side="left">
                                          <p>{t('modSettingsTab.resetToDefaultTooltip', { value: formatRawConfigValue(opt.default) })}</p>
                                        </TooltipContent>
                                      </Tooltip>
                                    )}
                                    {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                {filteredModGroups.length === 0 && (modSettingsSearch || modSettingsModifiedOnly) && (
                  <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
                    {modSettingsModifiedOnly && !modSettingsSearch ? (
                      <>
                        <Filter className="h-5 w-5 opacity-50" aria-hidden="true" />
                        <p className="text-sm">{t('modSettingsTab.noModifiedOptions')}</p>
                        <Button variant="ghost" size="sm" onClick={() => setModSettingsModifiedOnly(false)}>
                          {t('modSettingsTab.showAllOptions')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Search className="h-5 w-5 opacity-50" aria-hidden="true" />
                        <p className="text-sm">{t('modSettingsTab.noMatches', { query: modSettingsSearch.length > 60 ? modSettingsSearch.slice(0, 60) + '…' : modSettingsSearch, suffix: modSettingsModifiedOnly ? t('modSettingsTab.noMatchesInModified') : '' })}</p>
                        <div className="flex gap-2">
                          {modSettingsSearch && (
                            <Button variant="ghost" size="sm" onClick={() => setModSettingsSearch('')}>
                              {t('modSettingsTab.clearSearch')}
                            </Button>
                          )}
                          {modSettingsModifiedOnly && (
                            <Button variant="ghost" size="sm" onClick={() => setModSettingsModifiedOnly(false)}>
                              {t('modSettingsTab.showAllOptions')}
                            </Button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>

      <Dialog open={showBackups} onOpenChange={setShowBackups}>
        {/* flex flex-col, here and in Templates below (same fix as
            FolderBrowser.tsx): the fixed h-[400px] ScrollArea is most of the
            dialog, and as a grid row it never shrinks to the height cap, so
            the whole dialog scrolled instead -- Close was below the fold at
            open even at 1366x768, 100% zoom, and the wheel over the list
            scrolled the list first. In a flex column the list gives up the
            height and the filter row and footer stay on screen, down to the
            list's min-h-32 floor: its root is overflow-hidden, so without one
            it shrank to nothing on a short window (1280x720 at 200% zoom, a
            landscape phone) and left the count and Close around an empty
            strip, every Restore out of reach. Below the floor the whole
            dialog scrolls instead (DialogContent's overflow-y-auto). The
            height cap is DialogContent's dvh default, not the old 85vh/80vh:
            in a column a lower cap only takes rows off the list. Measured in
            Chromium, the list keeps 373px at 1366x768 and 156px at 1366x768
            at 150% zoom, and reaches the floor at 1280x720 at 150%. */}
        <DialogContent className="max-w-2xl flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="w-5 h-5" />
              {t('backupsDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {t('backupsDialog.description')}
            </DialogDescription>
          </DialogHeader>

          {/* Filter tabs. flex-wrap: five buttons are wider than a phone-width
              dialog; unwrapped they either widened the whole dialog into a
              sideways scroll (grid) or squashed into each other (flex-col). */}
          <div className="flex flex-wrap items-center gap-2 border-b pb-3">
            <span className="text-sm text-muted-foreground me-2">
              <Filter className="w-4 h-4 inline me-1" />
              {t('backupsDialog.filterLabel')}
            </span>
            {(['all', 'ini', 'sandbox', 'spawnpoints', 'spawnregions'] as const).map((filter) => (
              <Button
                key={filter}
                variant={backupFilter === filter ? 'default' : 'outline'}
                size="sm"
                onClick={() => setBackupFilter(filter)}
                className="capitalize"
              >
                {filter === 'all' ? t('backupsDialog.filterAll') : filter}
              </Button>
            ))}
          </div>

          <ScrollArea className="h-[400px] min-h-32">
            {backups.length === 0 ? (
              <EmptyState type="noData" title={t('backupsDialog.emptyTitle')} description={t('backupsDialog.emptyDesc')} compact />
            ) : (
              <div className="space-y-2">
                {backups
                  .filter(backup => {
                    if (backupFilter === 'all') return true
                    const filename = backup.filename.toLowerCase()
                    if (backupFilter === 'ini') return filename.includes('_ini_') || filename.endsWith('.ini')
                    if (backupFilter === 'sandbox') return filename.includes('sandbox')
                    if (backupFilter === 'spawnpoints') return filename.includes('spawnpoints')
                    if (backupFilter === 'spawnregions') return filename.includes('spawnregions')
                    return true
                  })
                  .map((backup) => {
                    // Determine file type from filename
                    const filename = backup.filename.toLowerCase()
                    let fileType = t('backupsDialog.typeConfig')
                    let typeColor = 'bg-muted-foreground'
                    if (filename.includes('_ini_') || filename.endsWith('.ini')) {
                      fileType = t('backupsDialog.typeIni')
                      typeColor = 'bg-primary'
                    } else if (filename.includes('sandbox')) {
                      fileType = t('backupsDialog.typeSandbox')
                      typeColor = 'bg-chart-4'
                    } else if (filename.includes('spawnpoints')) {
                      fileType = t('backupsDialog.typeSpawnPoints')
                      typeColor = 'bg-accent-foreground'
                    } else if (filename.includes('spawnregions')) {
                      fileType = t('backupsDialog.typeSpawnRegions')
                      typeColor = 'bg-warning'
                    }

                    return (
                      <div key={backup.filename} className="flex flex-col gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-start gap-3 sm:items-center">
                          <Badge className={`${typeColor} text-white text-xs`}>{fileType}</Badge>
                          <div className="min-w-0">
                            <p className="break-all text-sm font-medium font-mono" dir="auto" title={backup.filename}>{backup.filename}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatDateTime(backup.created, { seconds: true })} • {t('backupsDialog.sizeKb', { size: Math.round(backup.size / 1024) })}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 self-end sm:self-auto">
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={serverChangedSinceLoad}
                                  onClick={() => handleRestoreBackup(backup.filename)}
                                >
                                  <Upload className="w-4 h-4 me-1" />
                                  {t('backupsDialog.restore')}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t('backupsDialog.restoreTooltip')}</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                      </div>
                    )
                  })}
                {backups.filter(backup => {
                  if (backupFilter === 'all') return true
                  const filename = backup.filename.toLowerCase()
                  if (backupFilter === 'ini') return filename.includes('_ini_') || filename.endsWith('.ini')
                  if (backupFilter === 'sandbox') return filename.includes('sandbox')
                  if (backupFilter === 'spawnpoints') return filename.includes('spawnpoints')
                  if (backupFilter === 'spawnregions') return filename.includes('spawnregions')
                  return true
                }).length === 0 && backups.length > 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>{t('backupsDialog.noneForFilter', { filter: backupFilter })}</p>
                    <Button variant="link" size="sm" onClick={() => setBackupFilter('all')}>
                      {t('backupsDialog.showAllBackups')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </ScrollArea>

          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {t('backupsDialog.totalCount', { count: backups.length })}
            </p>
            <Button variant="outline" onClick={() => setShowBackups(false)}>
              {t('backupsDialog.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Templates Dialog */}
      <Dialog open={showTemplates} onOpenChange={setShowTemplates}>
        {/* flex flex-col, and the list's min-h-32 floor: see the Backups
            dialog above. */}
        <DialogContent className="max-w-2xl flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bookmark className="w-5 h-5" />
              <span className="flex items-center gap-1.5">
                {t('templatesDialog.title')}
                <HelpTip label={t('templatesDialog.title')}>{t('templatesDialog.applyTip')}</HelpTip>
              </span>
            </DialogTitle>
            <DialogDescription>
              {t('templatesDialog.description')}
            </DialogDescription>
          </DialogHeader>

          {/* Save as Template button */}
          <div className="flex items-center justify-between border-b pb-3">
            <span className="text-sm text-muted-foreground">
              {t('templatesDialog.savedCount', { count: templates.length })}
            </span>
            <Button onClick={() => setShowSaveTemplate(true)}>
              <Plus className="w-4 h-4 me-2" />
              {t('templatesDialog.saveCurrentAsTemplate')}
            </Button>
          </div>

          <ScrollArea className="h-[400px] min-h-32">
            {templates.length === 0 ? (
              <EmptyState type="noData" title={t('templatesDialog.emptyTitle')} description={t('templatesDialog.emptyDesc')} compact />
            ) : (
              <div className="space-y-3">
                {templates.map((template) => (
                  <div key={template.id} className="rounded-lg border p-4 transition-colors hover:bg-muted/50">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="font-medium break-words" dir="auto" title={template.name}>{template.name}</h4>
                          <Badge variant="secondary" className="text-xs">
                            {template.type === 'both' ? t('templatesDialog.typeBoth') : template.type.toUpperCase()}
                          </Badge>
                        </div>
                        {template.description && (
                          <p className="mt-1 break-words text-sm text-muted-foreground" dir="auto" title={template.description}>{template.description}</p>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span>{t('templatesDialog.createdLabel', { date: formatDate(template.created) })}</span>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            {template.hasIni && <CheckCircle className="w-3 h-3 text-primary" />}
                            {template.hasIni && t('activeServerStrip.iniLabel')}
                          </span>
                          {template.hasIni && template.hasSandbox && <span>•</span>}
                          <span className="flex items-center gap-1">
                            {template.hasSandbox && <CheckCircle className="w-3 h-3 text-primary" />}
                            {template.hasSandbox && t('activeServerStrip.sandboxLabel')}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 sm:ms-4 sm:self-start">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="default"
                                size="sm"
                                disabled={templateLoading}
                                onClick={() => handleApplyTemplate(template)}
                              >
                                {templateLoading ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <>
                                    <FolderOpen className="w-4 h-4 me-1" />
                                    {t('templatesDialog.apply')}
                                  </>
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('templatesDialog.applyTooltip')}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-11 w-11 text-destructive hover:text-destructive sm:h-9 sm:w-9"
                                onClick={() => handleDeleteTemplate(template.id, template.name)}
                                aria-label={t('templatesDialog.deleteAria', { name: template.name })}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('templatesDialog.deleteTooltip')}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTemplates(false)}>
              {t('templatesDialog.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Save Template Dialog */}
      <Dialog open={showSaveTemplate} onOpenChange={setShowSaveTemplate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Save className="w-5 h-5" />
              {t('saveTemplateDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {t('saveTemplateDialog.description')}
            </DialogDescription>
          </DialogHeader>

          {/* DialogBody (2026-09 dialog sweep): at 1280x620 and smaller,
              Save Config sat below the fold of a dialog that scrolled as a
              whole. */}
          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="template-name">{t('saveTemplateDialog.nameLabel')}</Label>
              <Input
                id="template-name"
                placeholder={t('saveTemplateDialog.namePlaceholder')}
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value.slice(0, 60))}
                maxLength={60}
              />
              <p className="text-xs text-muted-foreground">{t('saveTemplateDialog.nameCharCount', { count: newTemplateName.length })}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-desc">{t('saveTemplateDialog.descLabel')}</Label>
              <Textarea
                id="template-desc"
                placeholder={t('saveTemplateDialog.descPlaceholder')}
                value={newTemplateDesc}
                onChange={(e) => setNewTemplateDesc(e.target.value.slice(0, 240))}
                className="min-h-[80px] resize-y"
                maxLength={240}
              />
              <p className="text-xs text-muted-foreground">{t('saveTemplateDialog.descCharCount', { count: newTemplateDesc.length })}</p>
            </div>

            <div className="space-y-3">
              <Label>{t('saveTemplateDialog.includeLabel')}</Label>
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="font-medium">{t('saveTemplateDialog.includeIniTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('saveTemplateDialog.includeIniDesc')}</p>
                </div>
                <Switch
                  checked={saveTemplateIni}
                  onCheckedChange={setSaveTemplateIni}
                  aria-label={t('saveTemplateDialog.includeIniAria')}
                />
              </div>
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="font-medium">{t('saveTemplateDialog.includeSandboxTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('saveTemplateDialog.includeSandboxDesc')}</p>
                </div>
                <Switch
                  checked={saveTemplateSandbox}
                  onCheckedChange={setSaveTemplateSandbox}
                  aria-label={t('saveTemplateDialog.includeSandboxAria')}
                />
              </div>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSaveTemplate(false)}>
              {t('saveTemplateDialog.cancel')}
            </Button>
            <Button
              onClick={handleSaveTemplate}
              disabled={templateLoading || !newTemplateName.trim() || (!saveTemplateIni && !saveTemplateSandbox) || serverChangedSinceLoad}
            >
              {templateLoading ? (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 me-2" />
              )}
              {t('saveTemplateDialog.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* File Browser Dialog */}
      <Dialog open={fileBrowserOpen} onOpenChange={setFileBrowserOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="w-5 h-5" />
              {t('fileBrowserDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {t('fileBrowserDialog.description')}
            </DialogDescription>
          </DialogHeader>

          {/* Current path breadcrumb */}
          <div className="flex items-center gap-1.5 text-xs font-mono bg-muted/50 rounded-md px-3 py-2 overflow-x-auto">
            <span className="text-muted-foreground truncate" title={fileBrowserPath}>{fileBrowserPath || t('fileBrowserDialog.loadingPath')}</span>
          </div>

          {/* File listing */}
          <ScrollArea className="flex-1 min-h-[300px] max-h-[400px] border rounded-md">
            {fileBrowserLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="p-2 space-y-0.5">
                {/* Parent directory */}
                {fileBrowserParent && (
                  <button
                    onClick={() => browseTo(fileBrowserParent!)}
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-md hover:bg-muted/70 text-sm transition-colors"
                  >
                    <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
                    <span className="text-muted-foreground">..</span>
                  </button>
                )}

                {/* Directories */}
                {fileBrowserDirs.map(dir => (
                  <button
                    key={`d-${dir}`}
                    onClick={() => browseTo(fileBrowserPath + (fileBrowserPath.endsWith('/') || fileBrowserPath.endsWith('\\') ? '' : (fileBrowserPath.includes('/') ? '/' : '\\')) + dir)}
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-md hover:bg-muted/70 text-sm transition-colors"
                  >
                    <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
                    <span className="truncate">{dir}</span>
                  </button>
                ))}

                {/* Files */}
                {fileBrowserFiles.map(file => {
                  const fullPath = fileBrowserPath + (fileBrowserPath.endsWith('/') || fileBrowserPath.endsWith('\\') ? '' : (fileBrowserPath.includes('/') ? '/' : '\\')) + file.name
                  const isSelected = fileBrowserSelected === fullPath
                  return (
                    <button
                      key={`f-${file.name}`}
                      onClick={() => setFileBrowserSelected(fullPath)}
                      onDoubleClick={() => {
                        setFileBrowserSelected(fullPath)
                        setIniSettings(prev => ({ ...prev, [fileBrowserKey]: fullPath }))
                        setFileBrowserOpen(false)
                      }}
                      className={`flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm transition-colors ${
                        isSelected ? 'bg-primary/15 border border-primary/30 ring-1 ring-primary/20' : 'hover:bg-muted/70'
                      }`}
                    >
                      <FileText className="w-4 h-4 text-primary shrink-0" />
                      <span className="truncate flex-1 text-start">{file.name}</span>
                      <span className="text-xs text-muted-foreground shrink-0">{file.ext}</span>
                    </button>
                  )
                })}

                {/* Empty state */}
                {fileBrowserDirs.length === 0 && fileBrowserFiles.length === 0 && !fileBrowserParent && (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    {t('fileBrowserDialog.emptyNoParent')}
                  </div>
                )}
                {fileBrowserDirs.length === 0 && fileBrowserFiles.length === 0 && fileBrowserParent && (
                  <div className="text-center py-4 text-sm text-muted-foreground">
                    {t('fileBrowserDialog.emptyWithParent')}
                  </div>
                )}
              </div>
            )}
          </ScrollArea>

          {/* Preview + selection info */}
          {fileBrowserSelected && (
            <div className="flex items-start gap-3 bg-muted/30 rounded-md p-3 border">
              <div className="rounded-md border bg-background p-1 shrink-0">
                <AuthImage
                  filePath={fileBrowserSelected}
                  alt="Preview"
                  className="max-h-[64px] max-w-[120px] object-contain rounded"
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{fileBrowserSelected.split(/[/\\]/).pop()}</p>
                <p className="text-xs text-muted-foreground font-mono truncate mt-0.5" title={fileBrowserSelected}>{fileBrowserSelected}</p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setFileBrowserOpen(false)}>
              {t('fileBrowserDialog.cancel')}
            </Button>
            <Button onClick={confirmFileBrowserSelection} disabled={!fileBrowserSelected}>
              <Check className="w-4 h-4 me-2" />
              {t('fileBrowserDialog.selectFile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The one save affordance, for the tab on screen: "Unsaved changes ·
          Discard · Save" while it holds edits, Ctrl/Cmd+S, and the reason
          Save can't run. Discard never touches the server (only the form
          state), so it stays available while the server may be running. */}
      {saveTarget && (
        <SaveBar
          dirty={saveTarget.dirty}
          saving={saving}
          onSave={saveTarget.onSave}
          onDiscard={saveTarget.onDiscard}
          changeCount={saveTarget.changeCount}
          disabledReason={saveDisabledReason}
          saveLabel={saveTarget.saveLabel}
        />
      )}
    </div>
  )
}
