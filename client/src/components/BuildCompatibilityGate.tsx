import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  assessBuildCompatibility,
  compiledBuildMetadata,
  type BackendBuildMetadata,
} from '../lib/buildCompatibility'
import { isDemoMode } from '../lib/demo'

type GateState =
  | { status: 'checking' | 'compatible' }
  | { status: 'mismatch'; backend: BackendBuildMetadata }

export function BuildCompatibilityGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation('shell')
  const [state, setState] = useState<GateState>({ status: 'checking' })

  useEffect(() => {
    if (isDemoMode()) {
      setState({ status: 'compatible' })
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 8_000)
    fetch('/api/health', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Health check returned ${response.status}`)
        return response.json() as Promise<BackendBuildMetadata>
      })
      .then((backend) => {
        const result = assessBuildCompatibility(compiledBuildMetadata(), backend)
        setState(result.compatible ? { status: 'compatible' } : { status: 'mismatch', backend })
      })
      .catch(() => {
        // Authentication screens already surface an unreachable backend. The
        // compatibility gate only blocks a backend that answered with a
        // demonstrably different build.
        setState({ status: 'compatible' })
      })
      .finally(() => window.clearTimeout(timer))
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [])

  if (state.status === 'checking') {
    return <main className="min-h-screen bg-background" aria-label={t('buildGate.checking')} />
  }
  if (state.status === 'mismatch') {
    const frontend = compiledBuildMetadata()
    const backendVersion = state.backend.panelVersion || state.backend.version || t('buildGate.unknown')
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-xl rounded-lg border border-destructive/40 bg-card p-6 shadow-lg">
          <p className="text-sm font-semibold uppercase tracking-wide text-destructive">{t('buildGate.eyebrow')}</p>
          <h1 className="mt-2 text-2xl font-bold">{t('buildGate.title')}</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {t('buildGate.description')}
          </p>
          <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt>{t('buildGate.frontend')}</dt><dd className="font-mono">{frontend.panelVersion} ({frontend.buildSha.slice(0, 12)})</dd>
            <dt>{t('buildGate.backend')}</dt><dd className="font-mono">{backendVersion} ({String(state.backend.buildSha || t('buildGate.unknown')).slice(0, 12)})</dd>
          </dl>
          <button className="mt-6 rounded-md bg-primary px-4 py-2 text-primary-foreground" onClick={() => window.location.reload()}>
            {t('buildGate.checkAgain')}
          </button>
        </section>
      </main>
    )
  }
  return <>{children}</>
}
