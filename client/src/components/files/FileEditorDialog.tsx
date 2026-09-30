import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ClipboardCopy,
  History,
  Info,
  KeyRound,
  Loader2,
  Lock,
  RotateCcw,
  Save,
  WrapText,
  X,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import { filesApi, type ConfirmedResult } from '@/lib/filesApi'
import { formatBytes } from '@/lib/formatBytes'
import { copyText, cn } from '@/lib/utils'
import type { ConfirmToken, FileEntry, Hint, RootDescriptor, TextEol, TextReadOnlyReason, TrashItem } from '@/types/files'
import { EditorGutter } from './EditorGutter'
import { describeFilesError, errorCodeOf, errorParamsOf, formatFileDate } from './filesUi'

/**
 * Runs a mutation through the confirmation protocol (spec §A8): `initial`
 * tokens are sent up front, and an FM_CONFIRMATION_REQUIRED answer is asked
 * about once and retried once. `names` stand in for the file names in the
 * prompt when the server's `details` has none.
 */
export type RunConfirmed = <T>(
  run: (confirm: ConfirmToken[]) => Promise<T>,
  options?: { initial?: ConfirmToken[]; names?: string[] },
) => Promise<ConfirmedResult<T>>

interface LoadedDoc {
  etag: string
  bom: boolean
  eol: TextEol
  masked: boolean
  hints: Hint[]
  readOnly: boolean
  readOnlyReason: TextReadOnlyReason | null
}

interface FileEditorDialogProps {
  open: boolean
  profileId: string
  root: RootDescriptor
  entry: FileEntry
  /** Bumped by the page to ask for a close (the browser's Back button); still guarded. */
  closeSignal: number
  runConfirmed: RunConfirmed
  onClose: () => void
  /** A close request was declined because of unsaved changes. */
  onCloseCancelled: () => void
  onSaved: (entry: FileEntry) => void
  /** The file is over the editor's limit: show its end instead. */
  onTooLarge: () => void
}

const HINT_ORDER: Hint[] = ['restartToApply', 'panelRewritesKeys', 'luaChecksum', 'steamUpdateOverwrites', 'bridgeWorkshopEntries']

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

function countLines(text: string): number {
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
  return lines
}

// The text editor (spec §A14.3): a full-screen dialog, so while it's open
// the sidebar can't be reached (the app uses BrowserRouter, which has no
// route blocker). Losing typed work is the one thing it must never do:
// closing with unsaved changes asks first (Close, Esc, the X, and the Back
// button through `closeSignal`), and the page registers `beforeunload` only
// while there are unsaved changes. The text itself lives only in memory;
// nothing here writes to browser storage.
export function FileEditorDialog({
  open,
  profileId,
  root,
  entry,
  closeSignal,
  runConfirmed,
  onClose,
  onCloseCancelled,
  onSaved,
  onTooLarge,
}: FileEditorDialogProps) {
  const { t, i18n } = useTranslation('files')
  const { toast } = useToast()
  const confirm = useConfirm()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [doc, setDoc] = useState<LoadedDoc | null>(null)
  const [text, setText] = useState('')
  const [baseline, setBaseline] = useState('')
  const [wrap, setWrap] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<{ currentEtag: string | null } | null>(null)
  const [copied, setCopied] = useState(false)
  const [savedInfo, setSavedInfo] = useState<{ previousVersion: boolean } | null>(null)
  const [loadedVersion, setLoadedVersion] = useState<TrashItem | null>(null)
  const [versions, setVersions] = useState<TrashItem[] | null>(null)
  const [versionsError, setVersionsError] = useState<string | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLPreElement>(null)
  const escArmedRef = useRef(false)
  const closingRef = useRef(false)

  const dirty = doc !== null && text !== baseline
  const readOnly = doc?.readOnly ?? true
  const lineCount = useMemo(() => countLines(text), [text])
  const byteSize = useMemo(() => utf8Length(text), [text])

  // The page re-renders often (listing refreshes, uploads); only a change of
  // file may reload the text, or typed work would be replaced. So the
  // callback props are read through a ref, not listed as dependencies.
  const onTooLargeRef = useRef(onTooLarge)
  onTooLargeRef.current = onTooLarge

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setConflict(null)
    try {
      const result = await filesApi.getText(profileId, { root: root.id, path: entry.path, mode: 'edit' })
      setDoc({
        etag: result.etag,
        bom: result.bom,
        eol: result.eol,
        masked: result.masked,
        hints: result.hints,
        readOnly: result.readOnly,
        readOnlyReason: result.readOnlyReason,
      })
      setText(result.content)
      setBaseline(result.content)
      setLoadedVersion(null)
      setSavedInfo(null)
    } catch (error) {
      if (errorCodeOf(error) === 'FM_FILE_TOO_LARGE_FOR_EDITOR') {
        onTooLargeRef.current()
        return
      }
      setLoadError(describeFilesError(error))
    } finally {
      setLoading(false)
    }
  }, [entry.path, profileId, root.id])

  useEffect(() => {
    if (open) void load()
  }, [load, open])

  // The browser's own "leave site?" prompt, only while there is something to lose.
  useEffect(() => {
    if (!open || !dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty, open])

  const confirmDiscard = useCallback(() => confirm({
    title: t('confirm.discardTitle', { name: entry.name }),
    description: t('editor.unsaved'),
    confirmLabel: t('confirm.discardConfirm'),
    cancelLabel: t('actions.cancel'),
    destructive: true,
  }), [confirm, entry.name, t])

  const attemptClose = useCallback(async () => {
    if (closingRef.current) return
    if (!dirty) {
      onClose()
      return
    }
    closingRef.current = true
    try {
      if (await confirmDiscard()) onClose()
      else onCloseCancelled()
    } finally {
      closingRef.current = false
    }
  }, [confirmDiscard, dirty, onClose, onCloseCancelled])

  const lastCloseSignal = useRef(closeSignal)
  useEffect(() => {
    if (closeSignal === lastCloseSignal.current) return
    lastCloseSignal.current = closeSignal
    void attemptClose()
  }, [attemptClose, closeSignal])

  const save = useCallback(async (overrideEtag?: string) => {
    if (!doc || readOnly || saving) return
    if (doc.eol === 'mixed') {
      const ok = await confirm({
        title: t('confirm.changeTitle'),
        description: t('confirm.mixedEol'),
        confirmLabel: t('confirm.continue'),
        cancelLabel: t('actions.cancel'),
        variant: 'warning',
      })
      if (!ok) return
    }
    const eol: 'lf' | 'crlf' = doc.eol === 'crlf' ? 'crlf' : 'lf'
    const content = text
    setSaving(true)
    try {
      const result = await runConfirmed((tokens) => filesApi.saveText(profileId, {
        root: root.id,
        path: entry.path,
        content,
        etag: overrideEtag ?? doc.etag,
        eol,
        bom: doc.bom,
        confirm: tokens,
      }), { names: [entry.name] })
      if (!result.ok) return
      const saved = result.value
      setBaseline(content)
      setDoc((current) => current && { ...current, etag: saved.etag, eol: current.eol === 'mixed' ? 'lf' : current.eol, hints: saved.hints.length > 0 ? saved.hints : current.hints })
      setConflict(null)
      setLoadedVersion(null)
      setVersions(null)
      setSavedInfo({ previousVersion: saved.previousVersion !== null })
      toast({ title: t('editor.saved') })
      onSaved(saved.entry)
    } catch (error) {
      if (errorCodeOf(error) === 'FM_CONFLICT') {
        const currentEtag = errorParamsOf(error).currentEtag
        setConflict({ currentEtag: typeof currentEtag === 'string' ? currentEtag : null })
      } else {
        toast({ variant: 'destructive', title: describeFilesError(error) })
      }
    } finally {
      setSaving(false)
    }
  }, [confirm, doc, entry.name, entry.path, onSaved, profileId, readOnly, root.id, runConfirmed, saving, t, text, toast])

  const saveAnyway = async () => {
    const ok = await confirm({
      title: t('confirm.saveAnywayTitle'),
      description: t('confirm.saveAnywayBody'),
      confirmLabel: t('actions.saveAnyway'),
      cancelLabel: t('actions.cancel'),
      variant: 'warning',
    })
    if (!ok) return
    let etag = conflict?.currentEtag ?? null
    if (!etag) {
      try {
        etag = (await filesApi.getText(profileId, { root: root.id, path: entry.path, mode: 'edit' })).etag
      } catch (error) {
        toast({ variant: 'destructive', title: describeFilesError(error) })
        return
      }
    }
    await save(etag)
  }

  const copyMine = async () => {
    if (await copyText(text)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      return
    }
    // No clipboard (plain HTTP on a LAN): select it all so Ctrl+C works.
    textareaRef.current?.focus()
    textareaRef.current?.select()
  }

  const loadVersions = async () => {
    setVersionsError(null)
    try {
      const result = await filesApi.trashList(profileId, { root: root.id, originalPath: entry.path })
      setVersions(
        result.items
          .filter((item) => item.reason === 'edited')
          .sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt)),
      )
    } catch (error) {
      setVersions([])
      setVersionsError(describeFilesError(error))
    }
  }

  const loadVersion = async (item: TrashItem) => {
    if (dirty && !(await confirmDiscard())) return
    try {
      const result = await filesApi.getTrashText(profileId, { root: root.id, trashId: item.trashId })
      setText(result.content)
      setLoadedVersion(item)
    } catch (error) {
      toast({ variant: 'destructive', title: describeFilesError(error) })
    }
  }

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (escArmedRef.current) {
        // Esc, then Tab: let focus leave the field.
        escArmedRef.current = false
        return
      }
      if (readOnly) return
      event.preventDefault()
      const el = event.currentTarget
      const start = el.selectionStart
      const end = el.selectionEnd
      const next = `${text.slice(0, start)}\t${text.slice(end)}`
      setText(next)
      requestAnimationFrame(() => {
        el.selectionStart = start + 1
        el.selectionEnd = start + 1
      })
      return
    }
    if (event.key !== 'Escape') escArmedRef.current = false
  }

  const handleContentKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
  }

  const syncGutter = () => {
    if (gutterRef.current && textareaRef.current) gutterRef.current.scrollTop = textareaRef.current.scrollTop
  }

  const hints = (doc?.hints ?? []).filter((hint) => HINT_ORDER.includes(hint))
  const showMasked = !!doc && (doc.masked || doc.hints.includes('secretsMasked'))
  const eolLabel = doc?.eol === 'crlf' ? 'CRLF' : doc?.eol === 'lf' ? 'LF' : doc?.eol === 'mixed' ? 'LF/CRLF' : null

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) void attemptClose() }}>
      <DialogContent
        className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:rounded-lg [&>button:last-child]:hidden"
        onKeyDown={handleContentKeyDown}
        onEscapeKeyDown={(event) => {
          // Radix listens for Escape on the document before the textarea
          // sees it. Inside the text, the first Esc only arms "Tab leaves
          // the field"; a second Esc (or Esc anywhere else) closes, guarded.
          event.preventDefault()
          if (document.activeElement === textareaRef.current && !escArmedRef.current) {
            escArmedRef.current = true
            return
          }
          escArmedRef.current = false
          void attemptClose()
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex min-w-0 items-center gap-2 text-base">
              <bdi dir="ltr" className="truncate">{entry.name}</bdi>
              {readOnly && doc && (
                <Badge variant="outline" className="shrink-0 gap-1 px-2 py-0 text-[10px]">
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  {t('editor.readOnly')}
                </Badge>
              )}
              {dirty && (
                <Badge variant="warning" className="shrink-0 px-2 py-0 text-[10px]">{t('editor.unsaved')}</Badge>
              )}
            </DialogTitle>
            <DialogDescription className="mt-0.5 truncate text-xs">
              <bdi dir="ltr" className="font-mono">{entry.path}</bdi>
            </DialogDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={wrap ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={wrap}
              onClick={() => setWrap((value) => !value)}
            >
              <WrapText aria-hidden="true" />
              {t('editor.wrap')}
            </Button>
            {!readOnly && (
              <DropdownMenu onOpenChange={(next) => { if (next) void loadVersions() }}>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <History aria-hidden="true" />
                    {t('editor.versions.title')}
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 min-w-[16rem] overflow-y-auto">
                  <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('editor.versions.title')}
                  </DropdownMenuLabel>
                  {versions === null ? (
                    <div className="flex justify-center p-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" /></div>
                  ) : versionsError ? (
                    <p className="px-2 pb-2 text-xs text-destructive">{versionsError}</p>
                  ) : versions.length === 0 ? (
                    <p className="px-2 pb-2 text-xs text-muted-foreground">{t('editor.versions.empty')}</p>
                  ) : (
                    versions.map((item) => (
                      <DropdownMenuItem key={item.trashId} onSelect={() => void loadVersion(item)} className="min-h-11 flex-col items-start gap-0 sm:min-h-0">
                        <span className="text-sm">{formatFileDate(item.deletedAt, i18n.language)}</span>
                        {item.deletedBy.username && (
                          <span className="text-xs text-muted-foreground">{t('editor.versions.by', { username: item.deletedBy.username })}</span>
                        )}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {!readOnly && (
              <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || loading}>
                {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
                {t('actions.save')}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => void attemptClose()}>
              <X aria-hidden="true" />
              {t('actions.close')}
            </Button>
          </div>
        </div>

        <div className="space-y-2 px-4 pt-3 empty:hidden">
          {conflict && (
            <Alert className="border-warning/40 bg-warning/10">
              <AlertTriangle className="h-4 w-4 !text-warning" aria-hidden="true" />
              <AlertTitle className="text-warning">{t('editor.conflict.title')}</AlertTitle>
              <AlertDescription className="space-y-3 text-muted-foreground">
                <p>{t('editor.conflict.description')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => void load()}>
                    <RotateCcw aria-hidden="true" />
                    {t('actions.reload')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void copyMine()}>
                    {copied ? <Check aria-hidden="true" /> : <ClipboardCopy aria-hidden="true" />}
                    {t('actions.copyMyText')}
                  </Button>
                  <Button variant="warning" size="sm" onClick={() => void saveAnyway()} disabled={saving}>
                    <Save aria-hidden="true" />
                    {t('actions.saveAnyway')}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          {loadedVersion && (
            <Alert className="border-border/60 bg-muted/40">
              <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <AlertDescription className="text-muted-foreground">
                {t('editor.versions.loaded', { when: formatFileDate(loadedVersion.deletedAt, i18n.language) })}
              </AlertDescription>
            </Alert>
          )}
          {showMasked && (
            <Alert className="border-border/60 bg-muted/40" data-testid="files-editor-masked">
              <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <AlertDescription className="text-muted-foreground">{t('editor.hints.secretsMasked')}</AlertDescription>
            </Alert>
          )}
          {hints.map((hint) => (
            <Alert key={hint} className="border-border/60 bg-muted/40">
              <Info className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <AlertDescription className="text-muted-foreground">{t(`editor.hints.${hint}`)}</AlertDescription>
            </Alert>
          ))}
          {doc?.readOnlyReason === 'protected' && entry.protection && (
            <p className="text-xs text-muted-foreground">{t(`protected.areas.${entry.protection.area}`)}</p>
          )}
          {doc?.readOnlyReason === 'rootReadOnly' && root.readOnlyReason && (
            <p className="text-xs text-muted-foreground">{t(`roots.readOnlyReasons.${root.readOnlyReason}`)}</p>
          )}
        </div>

        <div className="min-h-0 flex-1 p-4">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
            </div>
          ) : loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p role="alert" className="max-w-md text-sm text-muted-foreground">{loadError}</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>{t('actions.retry')}</Button>
            </div>
          ) : (
            <div className="flex h-full overflow-hidden rounded-md border border-border/60 bg-input" dir="ltr">
              {!wrap && <EditorGutter ref={gutterRef} lineCount={lineCount} />}
              <textarea
                ref={textareaRef}
                dir="ltr"
                value={text}
                onChange={(event) => {
                  setText(event.target.value)
                  escArmedRef.current = false
                }}
                onKeyDown={handleTextareaKeyDown}
                onScroll={syncGutter}
                readOnly={readOnly}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                wrap={wrap ? 'soft' : 'off'}
                aria-label={entry.name}
                aria-describedby="files-editor-esc-hint"
                className={cn(
                  'h-full min-h-0 w-full flex-1 resize-none bg-transparent px-3 py-3 font-mono text-[13px] leading-5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
                )}
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{formatBytes(byteSize, i18n.language)}</span>
          <span>{t('editor.lineCount', { count: lineCount })}</span>
          {eolLabel && <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">{eolLabel}</Badge>}
          {doc?.bom && <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">{t('editor.bom')}</Badge>}
          <span aria-live="polite" className={cn('font-medium', dirty ? 'text-warning' : 'text-muted-foreground')}>
            {dirty ? t('editor.unsaved') : savedInfo ? t('editor.saved') : null}
          </span>
          {savedInfo?.previousVersion && !dirty && <span>{t('editor.previousVersion')}</span>}
          <span id="files-editor-esc-hint" className="ms-auto hidden sm:inline">{t('editor.escHint')}</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
