import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ServerProblem, ServerProblemFix } from '@/lib/api'

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** A finding's mod as the page names it: its name, else the id the log gave. */
export function problemModName(finding: ServerProblem): string | null {
  return finding.mod?.name ?? str(finding.params.modName) ?? finding.modId ?? null
}

/** The translated title, "why" and fix labels of a finding (problems namespace). */
export function useProblemText() {
  const { t } = useTranslation('problems')

  const title = useCallback((f: ServerProblem): string => {
    const p = f.params
    switch (f.kind) {
      case 'luaError':
        return problemModName(f) ? t('kinds.luaError.title', { mod: problemModName(f) }) : t('kinds.luaError.titleVanilla')
      case 'modRequiredMissing':
        return t('kinds.modRequiredMissing.title', { mod: str(p.missingModId) ?? '?' })
      case 'workshopDownload':
        return t('kinds.workshopDownload.title', { id: f.workshopId ?? '?' })
      case 'rconPortInUse':
        return t('kinds.rconPortInUse.title', { port: p.port ?? '?' })
      case 'javaException':
        return t('kinds.javaException.title', { exception: str(p.exception) ?? 'Exception' })
      case 'panelError':
        return t('kinds.panelError.title', { source: str(p.source) ?? 'Panel' })
      default:
        return t(`kinds.${f.kind}.title`)
    }
  }, [t])

  const why = useCallback((f: ServerProblem): string => {
    const p = f.params
    switch (f.kind) {
      case 'luaFileError':
        return t('kinds.luaFileError.why', { file: str(p.file) ?? '?' })
      case 'modRequiredMissing':
        return t('kinds.modRequiredMissing.why', { mod: str(p.missingModId) ?? '?' })
      case 'steamOff':
        return t('kinds.steamOff.why', { n: typeof p.items === 'number' ? p.items : 0 })
      case 'portInUse':
        return t('kinds.portInUse.why', { port: p.port ?? '?', code: p.code ?? '?' })
      case 'outOfMemory':
        return str(p.detail) ? t('kinds.outOfMemory.why', { detail: p.detail }) : t('kinds.outOfMemory.whyPlain')
      case 'chunkLoad': {
        const chunks = Array.isArray(p.chunks) ? (p.chunks as string[]) : []
        return t('kinds.chunkLoad.why', { chunks: chunks.slice(0, 3).join(' · ') || '?' })
      }
      default:
        return t(`kinds.${f.kind}.why`)
    }
  }, [t])

  const fixLabel = useCallback((fix: ServerProblemFix, f: ServerProblem): string => {
    if (fix.type === 'link') return t(`fix.${fix.id}`, { defaultValue: t('fix.open') })
    switch (fix.action) {
      case 'disableMod':
        return t('fix.disableMod', { mod: problemModName(f) ?? String(fix.params.modId ?? '') })
      case 'raiseMemory':
        return t('fix.raiseMemory', { current: fix.params.currentGb, next: fix.params.nextGb })
      default:
        return t(`fix.${fix.action}`)
    }
  }, [t])

  return useMemo(() => ({ title, why, fixLabel }), [title, why, fixLabel])
}
