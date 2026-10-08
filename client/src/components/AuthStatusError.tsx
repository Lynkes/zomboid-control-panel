import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { getResultErrorMessage } from '@/lib/errorMessage'

// The boot sign-in check got no usable answer (AuthContext's
// statusCheckFailed). Whether logins are on is unknown, so neither the panel
// nor a sign-in form fits; a 429 or a restarting panel usually clears on a
// retry.
export function AuthStatusError({ code, onRetry }: { code: string | null; onRetry: () => void }) {
  const { t } = useTranslation('shell')
  const waitAndRetry = t('authSession.statusCheckFailedDescription')
  // HOST_NOT_ALLOWED (logins off, opened by an address the panel does not
  // answer to) never clears on a retry, and its own text says what to do.
  // Other codes keep the card's text: AUTH_STATUS_CHECK_FAILED's says less.
  const description = code === 'HOST_NOT_ALLOWED' ? getResultErrorMessage({ code }, waitAndRetry) : waitAndRetry
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div role="alert" className="w-full max-w-md rounded-xl border border-border/70 bg-card/70 p-6">
        <h1 className="text-lg font-semibold tracking-tight">{t('authSession.statusCheckFailedTitle')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-5">
          <Button type="button" onClick={onRetry}>{t('authSession.retry')}</Button>
        </div>
      </div>
    </main>
  )
}
