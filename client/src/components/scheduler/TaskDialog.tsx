import { useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AlertCircle, AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, Loader2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { HelpTip } from '@/components/HelpTip'
import { useConfirmLeave, useUnsavedChangesGuard } from '@/contexts/UnsavedChangesContext'
import { schedulerApi, type ServerInstance } from '@/lib/api'
import {
  INTERVAL_HOURS,
  buildSimpleCron,
  formatRelativeTime,
  nextCronRuns,
  parseTimeOfDay,
  type ScheduleMode,
} from '@/lib/cronSchedule'
import { useDateFormat, zonedDateParts } from '@/lib/dateFormat'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { resolveRegisteredTranslation } from '@/lib/paramTranslation'
import { cn } from '@/lib/utils'
import { OptionGrid } from './OptionGrid'
import type { CronPreset, TaskDraft } from './taskDraft'
import {
  TASK_TYPE_ICONS,
  commandForTaskType,
  getCommandSuggestions,
  useScheduleText,
  type TaskType,
} from './scheduleText'

// Monday first, Sunday last.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const TASK_TYPES: TaskType[] = ['restart', 'save', 'broadcast', 'command', 'backup']
const NAME_MAX = 100
const COMMAND_MAX = 2000

type FieldError = 'type' | 'message' | 'command' | 'time' | 'days' | 'cron' | 'name'

interface TaskDialogProps {
  open: boolean
  onClose: () => void
  draft: TaskDraft
  /** Set when editing; the dialog creates a task otherwise. */
  editingTask: { id: number; name: string; enabled: number } | null
  servers: ServerInstance[]
  presets: CronPreset[]
  /** The zone every schedule runs in (scheduler status); absent while unknown. */
  timezone?: string
  backupScheduleEnabled?: boolean
  backupNextRun?: string | null
  onSaved: () => void
}

export function TaskDialog({
  open,
  onClose,
  draft,
  editingTask,
  servers,
  presets,
  timezone,
  backupScheduleEnabled,
  backupNextRun,
  onSaved,
}: TaskDialogProps) {
  const { t } = useTranslation('scheduler')
  const { toast } = useToast()
  const { formatDateTime, locale } = useDateFormat()
  const text = useScheduleText()
  const suggestions = useMemo(() => getCommandSuggestions(t), [t])
  const confirmLeave = useConfirmLeave()

  const [name, setName] = useState(draft.name)
  const [nameAuto, setNameAuto] = useState(draft.nameAuto)
  const [type, setType] = useState<TaskType | null>(draft.type)
  const [message, setMessage] = useState(draft.message)
  const [command, setCommand] = useState(draft.command)
  const [mode, setMode] = useState<ScheduleMode>(draft.mode)
  const [time, setTime] = useState(draft.time)
  const [everyHours, setEveryHours] = useState(draft.everyHours)
  const [days, setDays] = useState<number[]>(draft.days)
  const [cron, setCron] = useState(draft.cron)
  const [serverId, setServerId] = useState(draft.serverId)
  const [saving, setSaving] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  // scheduler-time-audit follow-up: POST /tasks and PUT /tasks/:id return a
  // non-null dstWarning when the saved schedule is sub-hourly in a
  // DST-observing zone (node-cron fires the repeated fall-back hour once).
  // The server string is plain English assembled from the schedule's own
  // data, not a translation key. Kept open so it is actually read.
  const [dstWarning, setDstWarning] = useState<string | null>(null)

  // Advisory-only preview of the Advanced cron via POST /validate-cron:
  // never gates Save, the server re-validates on create/update.
  const [cronValidation, setCronValidation] = useState<{ valid: boolean; error?: string; code?: string } | null>(null)
  const cronValidationIdRef = useRef(0)

  const parsedTime = parseTimeOfDay(time)
  const hoursStep = Math.min(Math.max(parseInt(everyHours, 10) || 1, 1), 23)
  const cronToUse = mode === 'advanced'
    ? cron.trim()
    : (mode === 'interval' || parsedTime) && (mode !== 'weekdays' || days.length > 0)
      ? buildSimpleCron({ mode, hour: parsedTime?.[0] ?? 0, minute: parsedTime?.[1] ?? 0, everyHours: hoursStep, days })
      : ''
  const summary = cronToUse ? text.describeCron(cronToUse) : null
  const commandToUse = commandForTaskType(type, message, command)
  const autoName = type && type !== 'backup'
    ? `${text.typeLabel(type)} · ${summary ?? cronToUse}`.slice(0, NAME_MAX).trim()
    : ''
  const effectiveName = nameAuto ? autoName : name

  // Unsaved-changes guard: the form as it opened (or was last saved) against
  // what it holds now. Backup saves nothing here, so it never holds edits.
  const snapshot = JSON.stringify([effectiveName, type, message, command, mode, time, everyHours, days, cron, serverId])
  const baselineRef = useRef<string | null>(null)
  if (baselineRef.current === null) baselineRef.current = snapshot
  const dirty = type !== 'backup' && baselineRef.current !== snapshot
  useUnsavedChangesGuard(open && dirty)

  useEffect(() => {
    if (mode !== 'advanced' || !cron.trim()) {
      setCronValidation(null)
      return
    }
    const validationId = ++cronValidationIdRef.current
    const timer = setTimeout(() => {
      schedulerApi.validateCron(cron)
        .then((result) => {
          if (cronValidationIdRef.current !== validationId) return
          setCronValidation(result)
        })
        // A failed preview call says nothing about the expression: clear any
        // stale verdict rather than show a wrong one.
        .catch(() => {
          if (cronValidationIdRef.current !== validationId) return
          setCronValidation(null)
        })
    }, 400)
    return () => clearTimeout(timer)
  }, [cron, mode])

  const nextRuns = useMemo(
    () => (timezone && cronToUse && cronValidation?.valid !== false ? nextCronRuns(cronToUse, timezone, 3) : null),
    [cronToUse, timezone, cronValidation?.valid],
  )

  const errors: Partial<Record<FieldError, string>> = {}
  if (!type) errors.type = t('taskType.required')
  if (type === 'broadcast' && !message.trim()) errors.message = t('taskType.messageRequired')
  if (type === 'command' && !command.trim()) errors.command = t('taskType.commandRequired')
  if ((mode === 'daily' || mode === 'weekdays') && !parsedTime) errors.time = t('when.timeRequired')
  if (mode === 'weekdays' && days.length === 0) errors.days = t('when.daysRequired')
  if (mode === 'advanced' && !cron.trim()) errors.cron = t('when.cronRequired')
  if (!effectiveName.trim()) errors.name = t('taskType.nameRequired')
  const shownError = (field: FieldError) => (showErrors ? errors[field] : undefined)

  const fieldIds: Record<FieldError, string> = {
    type: 'task-type',
    message: 'task-message',
    command: 'task-command',
    time: 'task-time',
    days: 'task-days',
    cron: 'task-cron',
    name: 'task-name',
  }

  const requestClose = async () => {
    if (dirty && !(await confirmLeave())) return
    onClose()
  }

  const chooseMode = (next: ScheduleMode) => {
    // The Advanced field starts from what the builder had, so switching
    // shows the cron behind the friendly schedule instead of a blank box.
    if (next === 'advanced' && !cron.trim() && cronToUse) setCron(cronToUse)
    setMode(next)
  }

  const toggleDay = (day: number) => {
    setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b)))
  }

  const handleSave = async () => {
    const firstError = (Object.keys(fieldIds) as FieldError[]).find((field) => errors[field])
    if (firstError) {
      setShowErrors(true)
      const field = document.getElementById(fieldIds[firstError])
      const focusable = field?.matches('input, textarea, button') ? field : field?.querySelector<HTMLElement>('button, input')
      focusable?.focus()
      return
    }

    // Validate against the server's own validator (node-cron's real rules,
    // named weekdays and L/W/# included), not a local regex that drifts.
    try {
      const cronCheck = await schedulerApi.validateCron(cronToUse)
      if (!cronCheck.valid) {
        toast({
          title: t('toasts.invalidScheduleTitle'),
          description:
            (cronCheck.code && resolveRegisteredTranslation('errors', cronCheck.code, undefined)) ||
            cronCheck.error ||
            t('toasts.invalidCronDesc', { cron: cronToUse }),
          variant: 'destructive',
        })
        return
      }
    } catch {
      // Pre-check unreachable: create/update's own validation decides.
    }

    setSaving(true)
    try {
      const taskName = effectiveName.trim()
      let result: { dstWarning?: string | null } | undefined
      if (editingTask) {
        result = await schedulerApi.updateTask(editingTask.id, taskName, cronToUse, commandToUse, !!editingTask.enabled, serverId || undefined)
      } else {
        result = await schedulerApi.createTask(taskName, cronToUse, commandToUse, serverId || undefined)
      }
      toast({
        title: t('toasts.successTitle'),
        description: editingTask ? t('toasts.taskUpdated') : t('toasts.taskCreated'),
        variant: 'success' as const,
      })
      onSaved()
      if (result?.dstWarning) {
        // Saved: what the form holds now is no longer an unsaved edit.
        baselineRef.current = snapshot
        setDstWarning(result.dstWarning)
      } else {
        onClose()
      }
    } catch (error) {
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, editingTask ? t('toasts.taskUpdateFailedFallback') : t('toasts.taskCreateFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const errorLine = (field: FieldError) => {
    const message = shownError(field)
    if (!message) return null
    return (
      <p id={`${fieldIds[field]}-error`} className="flex items-center gap-1.5 text-xs text-destructive">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {message}
      </p>
    )
  }
  const invalidProps = (field: FieldError) =>
    shownError(field) ? { 'aria-invalid': true, 'aria-describedby': `${fieldIds[field]}-error` } : {}

  const intervalOptions = INTERVAL_HOURS.includes(hoursStep as typeof INTERVAL_HOURS[number])
    ? [...INTERVAL_HOURS]
    : [...INTERVAL_HOURS, hoursStep].sort((a, b) => a - b)

  const timeField = (
    <div className="space-y-1.5">
      <Label htmlFor="task-time">{t('when.timeLabel')}</Label>
      <Input
        id="task-time"
        type="time"
        step={60}
        value={time}
        onChange={(event) => setTime(event.target.value)}
        className="w-36 tabular-nums"
        {...invalidProps('time')}
      />
      {errorLine('time')}
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) void requestClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editingTask ? t('dialog.editTitle') : t('dialog.createTitle')}</DialogTitle>
          <DialogDescription>
            {editingTask ? t('dialog.editDescription', { name: editingTask.name }) : t('dialog.createDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {dstWarning && (
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{t('dialog.dstWarningTitle')}</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                {/* dir="auto": the server's own English sentence, not a translation. */}
                <span dir="auto">{dstWarning}</span>
                <Button type="button" variant="outline" size="sm" className="self-start" onClick={onClose}>
                  {t('dialog.dstWarningDismiss')}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <section className="space-y-3" aria-labelledby="task-type-heading">
            <h3 id="task-type-heading" className="text-sm font-medium">{t('taskType.heading')}</h3>
            <OptionGrid
              id="task-type"
              value={type}
              onValueChange={setType}
              ariaLabelledBy="task-type-heading"
              ariaDescribedBy="task-type-help"
              items={TASK_TYPES.map((value) => ({ value, label: text.typeLabel(value), icon: TASK_TYPE_ICONS[value] }))}
              className="grid-cols-2 sm:grid-cols-5 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1"
            />
            <p id="task-type-help" className="text-xs text-muted-foreground">
              {type ? t(`taskType.${type}Desc`) : t('taskType.pickFirst')}
            </p>
            {errorLine('type')}

            {type === 'backup' && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {backupScheduleEnabled
                  ? backupNextRun
                    ? t('taskType.backupOnNext', { date: formatDateTime(backupNextRun) })
                    : t('taskType.backupOn')
                  : t('taskType.backupOff')}
              </p>
            )}

            {type === 'broadcast' && (
              <div className="space-y-1.5">
                <Label htmlFor="task-message">{t('taskType.messageLabel')}</Label>
                <Textarea
                  id="task-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={t('taskType.messagePlaceholder')}
                  maxLength={COMMAND_MAX - 'servermsg '.length}
                  rows={2}
                  dir="auto"
                  {...invalidProps('message')}
                />
                {errorLine('message')}
              </div>
            )}

            {type === 'command' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="task-command">{t('dialog.commandLabel')}</Label>
                    <HelpTip label={t('dialog.commandLabel')}>{t('dialog.commandTip')}</HelpTip>
                  </div>
                  <Input
                    id="task-command"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder={t('taskType.commandPlaceholder')}
                    className="font-mono"
                    maxLength={COMMAND_MAX}
                    autoComplete="off"
                    spellCheck={false}
                    dir="ltr"
                    {...invalidProps('command')}
                  />
                  {errorLine('command')}
                  {command.startsWith('bridge:') && (
                    <p className="text-xs text-muted-foreground">
                      <Trans
                        i18nKey="dialog.bridgeFormatHint"
                        t={t}
                        components={{ 1: <code className="text-foreground" />, 2: <code className="ms-1 text-foreground" /> }}
                      />
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <p className="label-micro" id="task-command-suggestions">{t('taskType.suggestions')}</p>
                  <ul className="flex flex-wrap gap-1.5" aria-labelledby="task-command-suggestions">
                    {suggestions.map((suggestion) => (
                      <li key={suggestion.value}>
                        <button
                          type="button"
                          onClick={() => setCommand(suggestion.value)}
                          title={suggestion.value}
                          aria-pressed={command === suggestion.value}
                          className={cn(
                            'rounded-md border px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 [@media(pointer:coarse)]:py-2',
                            command === suggestion.value
                              ? 'border-primary/60 bg-primary/10 text-foreground'
                              : 'border-border/60 bg-muted/25 text-muted-foreground hover:border-border hover:text-foreground',
                          )}
                        >
                          {suggestion.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </section>

          {type && type !== 'backup' && (
            <>
              <section className="space-y-4 border-t border-border/40 pt-5" aria-labelledby="task-when-heading">
                <h3 id="task-when-heading" className="text-sm font-medium">{t('when.heading')}</h3>
                <OptionGrid
                  value={mode}
                  onValueChange={chooseMode}
                  ariaLabelledBy="task-when-heading"
                  items={[
                    { value: 'daily', label: t('when.daily') },
                    { value: 'interval', label: t('when.interval') },
                    { value: 'weekdays', label: t('when.weekdays') },
                    { value: 'advanced', label: t('dialog.tabAdvanced') },
                  ]}
                  className="grid-cols-2 sm:grid-cols-4"
                />

                {mode === 'daily' && timeField}

                {mode === 'interval' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="task-interval">{t('when.repeatLabel')}</Label>
                    <Select value={String(hoursStep)} onValueChange={setEveryHours}>
                      <SelectTrigger id="task-interval" className="w-full sm:w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {intervalOptions.map((hours) => (
                          <SelectItem key={hours} value={String(hours)}>
                            {hours === 1 ? t('summary.hourly') : t('summary.everyNHours', { count: hours })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {mode === 'weekdays' && (
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <p className="text-sm font-medium" id="task-days-label">{t('when.daysLabel')}</p>
                      <div id="task-days" className="grid grid-cols-7 gap-1" role="group" aria-labelledby="task-days-label" {...invalidProps('days')}>
                        {DAY_ORDER.map((day) => {
                          const selected = days.includes(day)
                          return (
                            <button
                              key={day}
                              type="button"
                              aria-pressed={selected}
                              aria-label={text.dayName(day)}
                              title={text.dayName(day)}
                              onClick={() => toggleDay(day)}
                              className={cn(
                                'h-10 min-w-0 rounded-md border text-micro font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 [@media(pointer:coarse)]:h-11',
                                selected
                                  ? 'border-primary/60 bg-primary/15 text-foreground'
                                  : 'border-border/60 bg-muted/25 text-muted-foreground hover:border-border hover:text-foreground',
                              )}
                            >
                              {text.dayShort(day)}
                            </button>
                          )
                        })}
                      </div>
                      {errorLine('days')}
                    </div>
                    {timeField}
                  </div>
                )}

                {mode === 'advanced' && (
                  <div className="space-y-3">
                    {presets.length > 0 && (
                      <div className="space-y-1.5">
                        <Label htmlFor="task-cron-preset">{t('dialog.loadPresetLabel')}</Label>
                        <Select onValueChange={setCron}>
                          <SelectTrigger id="task-cron-preset">
                            <SelectValue placeholder={t('dialog.loadPresetPlaceholder')} />
                          </SelectTrigger>
                          <SelectContent>
                            {presets.map((preset) => (
                              <SelectItem key={preset.cron} value={preset.cron}>
                                {t('dialog.presetOption', { name: preset.name, cron: preset.cron })}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label htmlFor="task-cron">{t('dialog.customExpressionLabel')}</Label>
                      <Input
                        id="task-cron"
                        value={cron}
                        onChange={(event) => setCron(event.target.value)}
                        placeholder={t('dialog.customExpressionPlaceholder')}
                        className="font-mono"
                        maxLength={100}
                        dir="ltr"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={t('dialog.cronExpressionAria')}
                        {...(shownError('cron') ? { 'aria-invalid': true } : {})}
                        aria-describedby={shownError('cron') ? 'task-cron-error cron-format-hint' : 'cron-format-hint'}
                      />
                      <p id="cron-format-hint" className="text-xs text-muted-foreground">{t('dialog.cronFormatHint')}</p>
                      {errorLine('cron')}
                      {cronValidation && (
                        <p className={cn('flex items-center gap-1.5 text-xs', cronValidation.valid ? 'text-success' : 'text-destructive')} aria-live="polite">
                          {cronValidation.valid ? (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          ) : (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          )}
                          {cronValidation.valid
                            ? t('dialog.cronValidExpression')
                            : (cronValidation.code && resolveRegisteredTranslation('errors', cronValidation.code, undefined)) || cronValidation.error}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* What the schedule means, in words, and when it fires next:
                    the cron itself only shows in Advanced. */}
                <div className="space-y-3 rounded-xl border border-border/70 bg-background/40 p-4" aria-live="polite">
                  <p className="flex items-start gap-2 text-sm">
                    <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="font-medium text-foreground">
                        {summary ?? (cronToUse ? t('summary.custom') : t('summary.incomplete'))}
                      </span>
                      {timezone && (
                        <span className="text-muted-foreground"> · {timezone}</span>
                      )}
                    </span>
                  </p>
                  {nextRuns && nextRuns.length > 0 ? (
                    <div className="space-y-1.5">
                      <p className="label-micro">{t('summary.nextRuns')}</p>
                      <ol className="space-y-1">
                        {nextRuns.map((run) => (
                          <li key={run} className="flex items-baseline justify-between gap-3 text-sm tabular-nums">
                            <span className="flex min-w-0 items-baseline gap-2">
                              <span className="w-9 shrink-0 text-micro font-semibold text-muted-foreground">
                                {text.dayShort(zonedDateParts(run, timezone ?? 'UTC')?.weekday ?? 0)}
                              </span>
                              <span className="min-w-0 truncate">{formatDateTime(run, { timeZone: timezone, style: 'medium' })}</span>
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(run, locale)}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : mode === 'advanced' && cronToUse && timezone ? (
                    <p className="text-xs text-muted-foreground">{t('summary.noPreview')}</p>
                  ) : null}
                </div>
              </section>

              <section className="grid gap-4 border-t border-border/40 pt-5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="task-server">{t('dialog.targetServerLabel')}</Label>
                  <Select value={serverId} onValueChange={setServerId}>
                    <SelectTrigger id="task-server">
                      <SelectValue placeholder={t('dialog.targetServerPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {servers.map((server) => (
                        <SelectItem key={server.id} value={String(server.id)}>
                          {server.name || server.serverName}
                          {server.isActive ? t('dialog.targetServerActiveSuffix') : ''}
                          {server.isRemote ? t('dialog.targetServerRemoteSuffix') : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t('dialog.targetServerHelp')}</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="task-name">{t('dialog.taskNameLabel')}</Label>
                  <Input
                    id="task-name"
                    value={effectiveName}
                    onChange={(event) => {
                      setNameAuto(false)
                      setName(event.target.value)
                    }}
                    placeholder={t('dialog.taskNamePlaceholder')}
                    maxLength={NAME_MAX}
                    {...invalidProps('name')}
                  />
                  {errorLine('name')}
                  {nameAuto && <p className="text-xs text-muted-foreground">{t('taskType.nameAutoHint')}</p>}
                </div>
              </section>
            </>
          )}
        </DialogBody>
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="outline" onClick={() => { void requestClose() }}>
            {t('manualRestart.cancel')}
          </Button>
          {type === 'backup' ? (
            <Button asChild>
              <Link to="/backups?panel=schedule">
                {t('taskType.openBackupSchedule')}
                <ArrowRight className="rtl:-scale-x-100" aria-hidden="true" />
              </Link>
            </Button>
          ) : (
            <Button onClick={() => { void handleSave() }} disabled={saving}>
              {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
              {editingTask ? t('dialog.saveChanges') : t('dialog.createTaskButton')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
