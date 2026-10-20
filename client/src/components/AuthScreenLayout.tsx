import { ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { StatusPill } from './ui/status-pill'
import { LanguageSwitcher } from './LanguageSwitcher'

interface AuthScreenLayoutProps {
  /** Optional short line under the brand in the top bar (e.g. "Initial provisioning"). */
  badge?: string
  title: string
  description: string
  /** Optional sub-heading above the form, when the form needs its own name. */
  cardTitle?: string
  cardDescription?: string
  children: ReactNode
  /** Optional fine-print rendered below the card. Kept short — anything longer belongs in the form itself. */
  footer?: ReactNode
}

type PanelStatus = 'checking' | 'online' | 'unreachable'

/**
 * Auth shell for first-run Setup, in the same calm shape as the sign-in
 * screen: a top bar with the product name, the language switch and the
 * panel's real reachability (driven by /api/health, never decorative), and
 * one centred card. No kicker above the heading, no mono costume, no
 * scanlines: the operator is here to create an account, quickly.
 */
export function AuthScreenLayout({
  badge,
  title,
  description,
  cardTitle,
  cardDescription,
  children,
  footer,
}: AuthScreenLayoutProps) {
  const { t } = useTranslation('shell')
  const [status, setStatus] = useState<PanelStatus>('checking')
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const poll = async () => {
      try {
        const r = await fetch('/api/health', { signal: controller.signal })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const data = await r.json()
        if (cancelled) return
        setStatus('online')
        if (typeof data?.version === 'string') setVersion(data.version)
      } catch {
        if (cancelled) return
        setStatus('unreachable')
      }
    }

    poll()
    const id = setInterval(poll, 15000)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(id)
    }
  }, [])

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <a
        href="#auth-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:start-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:text-sm"
      >
        {t('skipToContent')}
      </a>

      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--primary)/0.10),transparent_34rem)]"
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-border/70" />

      <header className="relative mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-5 text-sm sm:px-8">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t('brand.title', { ns: 'login' })}</p>
          {badge ? <p className="mt-0.5 text-xs text-muted-foreground">{badge}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          <LanguageSwitcher />
          <PanelStatusPill status={status} />
          {version && <span className="hidden font-mono sm:inline">v{version}</span>}
        </div>
      </header>

      <main
        id="auth-content"
        className="relative mx-auto flex w-full max-w-6xl flex-col items-center px-5 pb-12 pt-4 sm:px-8"
      >
        <section
          aria-labelledby="auth-title"
          className="w-full max-w-[460px] rounded-lg border border-border/70 bg-card/90 p-6 shadow-[0_24px_80px_-48px_hsl(var(--foreground)/0.45)] sm:p-7"
        >
          <div className="mb-6 space-y-2">
            <h1 id="auth-title" className="text-2xl font-semibold tracking-normal text-foreground">
              {title}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
          {cardTitle || cardDescription ? (
            <div className="mb-4 space-y-1 border-t border-border/50 pt-4">
              {cardTitle ? <h2 className="text-sm font-medium text-foreground">{cardTitle}</h2> : null}
              {cardDescription ? <p className="text-xs leading-5 text-muted-foreground">{cardDescription}</p> : null}
            </div>
          ) : null}
          <div className="space-y-5">{children}</div>
        </section>

        {footer ? (
          <p className="mx-auto mt-4 max-w-[460px] text-center text-xs leading-5 text-muted-foreground">{footer}</p>
        ) : null}
      </main>
    </div>
  )
}

function PanelStatusPill({ status }: { status: PanelStatus }) {
  const { t } = useTranslation('shell')
  const tone = status === 'online' ? 'ok' : status === 'unreachable' ? 'error' : 'busy'
  return (
    <StatusPill
      role="status"
      aria-live="polite"
      size="sm"
      tone={tone}
      pulse={status === 'unreachable'}
      label={t(`panelStatus.${status}`)}
    />
  )
}
