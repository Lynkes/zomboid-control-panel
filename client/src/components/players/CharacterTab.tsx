import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/EmptyState'
import type { CharacterSheet, CharacterSheetResponse } from '@/lib/characterApi'
import { inventoryAnnotations } from '@/lib/characterInventory'
import { CharacterCondition } from './CharacterCondition'
import { CharacterHints } from './CharacterHints'
import { CharacterInventory } from './CharacterInventory'
import { CharacterSkills } from './CharacterSkills'
import { CharacterSummary } from './CharacterSummary'
import type { CharacterSheetState } from './useCharacterSheet'
import { formatTime, formatWhen } from './characterFormat'

// The Players page's Character tab: a state strip (live, last known, or why
// not), then Summary, Worth a look, Condition, Skills and Inventory. Data and
// polling come from useCharacterSheet, which the page owns so the dossier
// badge works on every tab.

interface ResolvedView {
  sheet: CharacterSheet | null
  lastKnown: boolean
  savedAt: string | null
}

function resolveView(base: CharacterSheetResponse): ResolvedView {
  if (base.availability === 'live' || base.availability === 'partial') {
    return { sheet: base.sheet, lastKnown: false, savedAt: null }
  }
  if (base.cached) return { sheet: base.cached.sheet, lastKnown: true, savedAt: base.cached.at }
  return { sheet: null, lastKnown: false, savedAt: null }
}

function resolveInventory(state: CharacterSheetState, base: CharacterSheetResponse, view: ResolvedView) {
  const response = state.inventory
  if (response?.availability === 'live' && response.sheet?.inventory) {
    return {
      inventory: response.sheet.inventory,
      loadedAt: response.fetchedAt,
      savedAt: null,
      sectionError: response.sheet.sectionErrors?.inventory,
    }
  }
  const saved = response?.cached ?? (view.lastKnown ? base.cached : null)
  if (saved?.sheet.inventory) {
    return { inventory: saved.sheet.inventory, loadedAt: null, savedAt: saved.inventoryAt ?? saved.at, sectionError: undefined }
  }
  return { inventory: null, loadedAt: null, savedAt: null, sectionError: response?.sheet?.sectionErrors?.inventory }
}

export function CharacterTab({
  username,
  online,
  state,
}: {
  username: string
  online: boolean
  state: CharacterSheetState
}) {
  const { t, i18n } = useTranslation('players')
  const language = i18n.language
  const { base, baseLoading, baseError } = state
  const hints = base?.hints
  const annotations = useMemo(() => inventoryAnnotations(hints), [hints])

  if (!username) {
    return <p className="text-sm text-muted-foreground">{t('character.state.noTarget')}</p>
  }
  if (!base) {
    if (baseError && !baseLoading) {
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-destructive">{baseError}</span>
          <Button type="button" variant="outline" size="sm" className="h-8" onClick={state.retry}>
            {t('character.state.retry')}
          </Button>
        </div>
      )
    }
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t('character.state.loading')}
      </div>
    )
  }

  const view = resolveView(base)
  const { availability } = base
  const bridgeProblem = availability === 'bridgeOffline' || availability === 'timeout'

  if (!view.sheet) {
    if (availability === 'playerOffline') {
      return (
        <EmptyState
          type="noPlayers"
          compact
          title={t('character.state.offlineNoCacheTitle')}
          description={t('character.state.offlineNoCacheBody')}
        />
      )
    }
    return (
      <EmptyState
        type="serverOffline"
        compact
        title={t('character.state.unavailableTitle')}
        description={`${availability === 'timeout' ? t('character.state.timeout') : t('character.state.bridgeOffline')} ${t('character.state.unavailableBody')}`}
        action={{ label: t('character.state.retry'), onClick: state.retry }}
      />
    )
  }

  const sheet = view.sheet
  const inventoryView = resolveInventory(state, base, view)
  const canLoadInventory = availability === 'live' && online

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {view.lastKnown ? (
            <>
              <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                {t('character.state.lastKnown')}
              </Badge>
              {view.savedAt && <span>{t('character.state.savedAt', { when: formatWhen(view.savedAt, language) })}</span>}
            </>
          ) : (
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {t('character.state.live', { time: formatTime(base.fetchedAt, language) })}
            </span>
          )}
          {baseLoading && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={state.refresh}
          disabled={baseLoading}
          aria-label={t('character.state.refreshAria')}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t('character.state.refresh')}
        </Button>
      </div>

      {baseError && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-destructive">{baseError}</span>
          <Button type="button" variant="outline" size="sm" className="h-8" onClick={state.retry}>
            {t('character.state.retry')}
          </Button>
        </div>
      )}

      {bridgeProblem && (
        <p className="flex items-start gap-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {availability === 'timeout' ? t('character.state.timeout') : t('character.state.bridgeOffline')}{' '}
            {view.savedAt && t('character.state.showingSaved', { when: formatWhen(view.savedAt, language) })}
          </span>
        </p>
      )}

      {availability === 'partial' && (
        <Alert className="border-warning/40 bg-warning/10">
          <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
          <AlertTitle className="text-warning">{t('character.state.partialTitle')}</AlertTitle>
          <AlertDescription>{t('character.state.partialBody')}</AlertDescription>
        </Alert>
      )}

      {availability !== 'partial' && (sheet.summary || sheet.traits) && <CharacterSummary sheet={sheet} record={base.record} />}

      {availability !== 'partial' && (
        <div className="border-t border-border/40 pt-4">
          <CharacterHints
            hints={base.hints}
            hintSource={base.hintSource}
            thresholds={base.hintThresholds}
            savedAt={base.cached?.at ?? view.savedAt}
          />
        </div>
      )}

      <div className="border-t border-border/40 pt-4">
        <CharacterCondition sheet={sheet} />
      </div>

      {availability !== 'partial' && sheet.skills && (
        <div className="border-t border-border/40 pt-4">
          <CharacterSkills
            skills={sheet.skills}
            skillDelta={view.lastKnown ? null : base.skillDelta}
            sectionError={sheet.sectionErrors?.skills}
          />
        </div>
      )}

      {availability !== 'partial' && (
        <div className="border-t border-border/40 pt-4">
          <CharacterInventory
            inventory={inventoryView.inventory}
            loadedAt={inventoryView.loadedAt}
            savedAt={inventoryView.savedAt}
            requested={state.inventoryRequested}
            loading={state.inventoryLoading}
            error={state.inventoryError}
            canLoad={canLoadInventory}
            onLoad={state.loadInventory}
            onVisibleChange={state.setInventoryVisible}
            annotations={annotations}
            sectionError={inventoryView.sectionError}
          />
        </div>
      )}
    </div>
  )
}
