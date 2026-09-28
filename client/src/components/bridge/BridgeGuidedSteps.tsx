import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Check, Copy, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { copyText } from '@/lib/utils'
import type { DeliveryMethod } from '@/lib/bridgeDeliveryTypes'
import type { GuidedManual } from '@/lib/bridgeDeliveryView'

interface GuidedStep {
  key: string
  values?: Record<string, string>
  // Exact text the operator pastes into their host's editor, each with its
  // own Copy button -- retyping a 10-digit Workshop id is where a manual
  // edit goes wrong.
  copy: string[]
}

// null when there is nothing safe to show. The Workshop list needs both ini
// entries (I1): a Mods= entry without its WorkshopItems= id names a mod no
// one can download, and every join then fails with ModRequired (§3). So
// with no known item id, the Mods= step is never shown on its own either.
function buildSteps(to: DeliveryMethod, manual: GuidedManual, file: string): GuidedStep[] | null {
  if (to === 'workshop') {
    if (!manual.workshopItemsEntry) return null
    const modsValue = `;${manual.modsEntry}`
    const itemsValue = `;${manual.workshopItemsEntry}`
    return [
      { key: 'guided.toWorkshop.step1', values: { file, value: modsValue }, copy: [modsValue] },
      { key: 'guided.toWorkshop.step2', values: { value: itemsValue }, copy: [itemsValue] },
      ...(manual.removeFiles.length > 0 ? [{ key: 'guided.toWorkshop.step3', copy: manual.removeFiles }] : []),
      { key: 'guided.toWorkshop.step4', copy: [] },
      { key: 'guided.toWorkshop.step5', copy: [] },
    ]
  }
  return [
    {
      key: 'guided.toLocal.step1',
      values: { file },
      copy: [manual.modsEntry, manual.workshopItemsEntry].filter((v): v is string => Boolean(v)),
    },
    { key: 'guided.toLocal.step2', copy: [] },
    { key: 'guided.toLocal.step3', values: { file }, copy: [] },
    { key: 'guided.toLocal.step4', copy: [] },
  ]
}

function CopyValue({ value }: { value: string }) {
  const { t } = useTranslation('bridgeDelivery')
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
  }, [])

  const onCopy = async () => {
    const ok = await copyText(value)
    if (!ok) {
      toast({ title: t('action.copyFailed'), variant: 'destructive' })
      return
    }
    setCopied(true)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded border border-border/60 bg-background/60 ps-2">
      {/* dir="ltr": ini values and paths read left to right even inside an
          RTL sentence -- ";123" must not render as "123;". */}
      <code dir="ltr" className="break-all font-mono text-xs">{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="iconDense"
        className="h-8 w-8 shrink-0"
        onClick={() => void onCopy()}
        title={copied ? t('action.copied') : t('action.copy')}
        aria-label={copied ? t('action.copied') : t('action.copyValueAria', { value })}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </span>
  )
}

interface BridgeGuidedStepsProps {
  to: DeliveryMethod
  manual: GuidedManual
  // `<ServerName>.ini` of the active profile, when known.
  iniFileName: string | null
}

// Manual steps for a server whose files the panel can't reach (remote SFTP,
// hosted, Docker-managed without a host mount). The panel only records the
// choice; the heartbeat confirms it (§4.6 guided access).
export function BridgeGuidedSteps({ to, manual, iniFileName }: BridgeGuidedStepsProps) {
  const { t } = useTranslation('bridgeDelivery')
  const file = iniFileName ?? t('guided.iniFallback')
  const steps = buildSteps(to, manual, file)
  if (!steps) return null
  // The translations wrap {{file}} in <file>, not <code>: a real file name
  // is a value (monospace, forced LTR), but the fallback is a translated
  // phrase ("the server's .ini file"), which must stay in the sentence's
  // own direction -- an Arabic phrase inside an LTR embedding reads
  // scrambled.
  const fileComponent = iniFileName ? <code dir="ltr" className="rounded bg-background px-1 font-mono text-xs break-all" /> : <span />

  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-muted/40 p-3 text-sm" data-testid="bridge-guided-steps">
      <p className="flex items-start gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span>{t('guided.intro')}</span>
      </p>
      <ol className="list-decimal space-y-2 ps-6">
        {steps.map((step) => (
          <li key={step.key} className="space-y-1.5">
            <p className="break-words">
              <Trans
                t={t}
                i18nKey={step.key}
                values={step.values}
                components={{
                  code: <code dir="ltr" className="rounded bg-background px-1 font-mono text-xs break-all" />,
                  file: fileComponent,
                }}
              />
            </p>
            {step.copy.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {step.copy.map((value) => (
                  <CopyValue key={value} value={value} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      {to === 'workshop' && <p className="text-xs text-muted-foreground">{t('guided.keepChecksumOff')}</p>}
    </div>
  )
}
