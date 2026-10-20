import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MessagesSquare,
  Send,
  Users,
  Megaphone,
  Loader2,
  RefreshCw,
  Shield,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  Check,
  X,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { PageAlerts, type PageAlert } from '@/components/PageAlerts'
import { SectionCard } from '@/components/ui/section-card'
import { StatusPill } from '@/components/ui/status-pill'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { ApiError, panelBridgeApi, playersApi, configApi } from '@/lib/api'
import { useSocket } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useAuth } from '@/contexts/AuthContext'
import { DisabledReason } from '@/components/DisabledReason'
import { EmptyState } from '@/components/EmptyState'
import { HelpTip } from '@/components/HelpTip'
import { cn } from '@/lib/utils'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { formatTime } from '@/lib/dateFormat'
import { useRequestGuard } from '@/hooks/useRequestGuard'

interface ChatMessage {
  id: string
  type: string
  author?: string
  message: string
  timestamp: Date
  // PZ's own chat room title (e.g. "Private" for a whisper, "Faction",
  // "Safehouse", "Radio", "Shout") -- finer-grained than `type`, which only
  // has 3 buckets (server/admin/general) for styling. Used to flag a
  // channel that isn't plain public chat even though it still falls into
  // the 'general' bucket (see getChannelTag below).
  sourceChatType?: string
}

interface Player {
  name: string
}

type ChatChannel = 'server' | 'admin' | 'general'

// bug-hunt-2026-09-18 (round 21, UX follow-up): PZ's general chat has no
// concept of "the panel" as a poster -- sendToGeneralChat's second argument
// IS the author name that actually appears in-game, verbatim, in every
// locale (there is no way to translate what a player sees there; PZ just
// stores and echoes the literal string it was given). sendMessage() below
// used to send this exact literal but then label its own local echo with
// t('labels.admin') -- a translated word -- so a non-English operator saw
// their own post attributed to a name real players never actually see.
// Worse than cosmetic: the socket echo dedup a few effects down
// (isOptimisticEcho) matches the local echo against the real server-log
// echo by comparing author strings case-insensitively -- a translated
// local author never matches the literal one PZ echoes back, so the same
// message appeared TWICE in the chat for any non-English locale. One
// constant, used at both the send call and the local echo (and the
// HelpTip explaining this channel below), so the three can never drift
// apart again silently. Distinct from 'admin' chat's own `t('labels.admin')`
// local-echo label just below -- chat/admin takes no author argument at
// all (server/routes/panelBridge.js), so that label is a purely internal,
// correctly-translated panel concept, not a name PZ shows anyone.
const GENERAL_CHAT_AUTHOR = 'Admin'

function isBridgeNotRunning(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'BRIDGE_NOT_RUNNING' || error.code === 'BRIDGE_NOT_RUNNING_BARE')
}

export default function Chat() {
  const { t, i18n } = useTranslation('chat')
  // bug-hunt-2026-09-18 (round 22): i18next's returnObjects always returns a
  // freshly-copied array (never the same reference twice, even for the same
  // key/language -- see i18next's translate(), which does
  // `const copy = resTypeIsArray ? [] : {}`), so computing this inline on
  // every render fed a runaway loop into the settings-load effect below:
  // that effect depends on [defaultPresets], and whenever saved presets are
  // empty it calls setPresets(defaultPresets) with a brand-new reference
  // every time -- React never sees the same value twice, so it never bails
  // out of re-rendering, which recomputes defaultPresets again, which
  // re-fires the effect again, forever (this is also why a NON-empty saved
  // list never hung: setPresets(saved) passes the same settings-response
  // reference back each time, so React bails out after the first update).
  // Memoizing on language keeps the array identity stable across unrelated
  // re-renders, so the effect only ever legitimately re-fires on a real
  // language change.
  const defaultPresets = useMemo(() => t('presets.default', { returnObjects: true }) as string[], [t, i18n.language])
  const [message, setMessage] = useState('')
  const [players, setPlayers] = useState<Player[]>([])
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [channel, setChannel] = useState<ChatChannel>('server')
  const [presets, setPresets] = useState<string[]>(defaultPresets)
  const [presetsEditing, setPresetsEditing] = useState(false)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editingDraft, setEditingDraft] = useState('')
  const [newPresetDraft, setNewPresetDraft] = useState('')

  const chatEndRef = useRef<HTMLDivElement>(null)
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
  const messageInputRef = useRef<HTMLInputElement>(null)
  const stickToBottomRef = useRef(true)
  const sendingRef = useRef(false)
  const { toast } = useToast()
  const confirm = useConfirm()
  const socket = useSocket()
  // Three genuinely different capabilities on this one page. Sending on the
  // 'server' channel (POST /panel-bridge/message, plain broadcast, no
  // spoofable author) requires server.world_events, same as weather/zombie/
  // climate tools. Sending on 'admin' or 'general' (POST /panel-bridge/
  // chat/admin, chat/general) requires players.endanger_or_impersonate
  // instead -- split out of server.world_events 2026-08-27 (operator ruling
  // on ranked-bug #5) specifically because chat/general accepts an
  // arbitrary custom author name, indistinguishable in the chat log from
  // that player having said it themselves; chat/admin moved with it as the
  // same kind of harm (server/routes/panelBridge.js:4024, 4083). Managing
  // the quick-broadcast preset list (add/edit/delete, PUT /config/app-
  // settings with chatPresets) requires panel.settings instead (server/
  // routes/config.js:256; chatPresets is confirmed NOT in that route's
  // per-key SETTINGS_KEY_CAPABILITY elevation map, so no secondary check
  // applies). None of TECHNICIAN/MODERATOR hold players.endanger_or_impersonate
  // or panel.settings by default (admin-only), so every non-admin stock
  // role can broadcast on 'server' but not send as admin/general or save
  // presets -- a live gap, not a hypothetical one.
  const { can } = useAuth()
  const canSendServerChat = can('server.world_events')
  const canSendTargetedChat = can('players.endanger_or_impersonate')
  const canSendChat = channel === 'server' ? canSendServerChat : canSendTargetedChat
  const canManagePresets = can('panel.settings')

  // Whether the game's native ChatServer API is answering right now, or the
  // three send paths above are silently degrading to player:Say/RCON --
  // never observable before this (nothing else on the page or elsewhere in
  // the panel reads getChatInfo). Fetched once on mount, not polled: this
  // doesn't change mid-session the way bridge connection or player counts
  // do, so a live poll would just be waste. Same capability as sending on
  // the server channel -- read-only, but there is no dedicated read gate
  // for this and inventing one for a single diagnostic call is not
  // proportionate.
  const [nativeChatAvailable, setNativeChatAvailable] = useState<boolean | null>(null)
  // The same call says when PanelBridge isn't running at all (the route
  // answers BRIDGE_NOT_RUNNING): server broadcasts then fail and the other
  // two channels fall back to RCON, so the page says so and links to the fix.
  const [bridgeOffline, setBridgeOffline] = useState(false)
  // Re-read after an active-server switch: the new server's bridge can be in
  // a different state, and a stale "not running" would send the operator to
  // fix something that isn't broken.
  const [chatInfoEpoch, setChatInfoEpoch] = useState(0)
  useEffect(() => {
    if (!canSendServerChat) return
    let active = true
    panelBridgeApi.getChatInfo()
      .then((res) => {
        if (!active) return
        setBridgeOffline(false)
        if (res.success && res.data) setNativeChatAvailable(res.data.chatServerAvailable)
      })
      .catch((error) => {
        if (active) setBridgeOffline(isBridgeNotRunning(error))
      })
    return () => { active = false }
  }, [canSendServerChat, chatInfoEpoch])

  // Track whether the user is parked at (or near) the bottom of the
  // scroll viewport. We only auto-scroll on new messages when they are,
  // so reading older history isn't yanked back by every incoming line.
  const handleScroll = useCallback(() => {
    const el = scrollViewportRef.current
    if (!el) return
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight)
    stickToBottomRef.current = distance < 80
  }, [])

  useEffect(() => {
    // ScrollArea (Radix) renders a viewport div with [data-radix-scroll-area-viewport].
    const root = chatEndRef.current?.closest('[data-radix-scroll-area-viewport]') as HTMLDivElement | null
    scrollViewportRef.current = root
    if (!root) return
    root.addEventListener('scroll', handleScroll, { passive: true })
    return () => root.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  useEffect(() => {
    if (stickToBottomRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [chatHistory])

  // bug-hunt-2026-09-18 (round 9, activeServerChanged race sweep): runs on a
  // 15s poll AND on activeServerChanged, with no guard against the two
  // overlapping -- a poll tick for the server that was active a moment ago,
  // still in flight, could resolve AFTER the activeServerChanged-triggered
  // call for the NEW server and overwrite it. playersGuard drops a response
  // once a newer call has already started.
  const playersGuard = useRequestGuard()
  const fetchPlayers = useCallback(async () => {
    const requestId = playersGuard.next()
    try {
      const data = await playersApi.getPlayers()
      if (playersGuard.isStale(requestId)) return
      if (data.players) {
        setPlayers(data.players)
      }
    } catch (error) {
      if (playersGuard.isStale(requestId)) return
      reportClientError('Failed to fetch players.', error)
    }
  }, [playersGuard])

  useEffect(() => {
    fetchPlayers()
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      fetchPlayers()
    }, 15000)
    return () => clearInterval(interval)
  }, [fetchPlayers])

  // bug-hunt-2026-09-04/06 (activeServerChanged sweep): this page never
  // re-read the active server after mount, same gap as Console.tsx/
  // Dashboard.tsx before their own fixes -- the player roster (used to
  // target admin/general chat) is a read-only display with no unsaved-edit
  // risk, so this reloads unconditionally, matching the Console-shape
  // precedent. chatHistory used to be left alone here (Console.tsx's liveLog
  // was too, until it started clearing on a switch): the lines already shown
  // came from the server that was active before, `chat:message` carries no
  // server id, and they stayed under the new server's name next to its own
  // lines. They are cleared now. There is no chat history endpoint to refetch
  // from -- the page is a live view of the log tailer, which the switch
  // repoints at the new server -- so what follows is that server's chat.
  useEffect(() => {
    if (!socket) return
    const onActiveServerChanged = () => {
      setChatHistory([])
      setNativeChatAvailable(null)
      setBridgeOffline(false)
      setChatInfoEpoch((epoch) => epoch + 1)
      fetchPlayers()
    }
    socket.on('activeServerChanged', onActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', onActiveServerChanged)
    }
  }, [socket, fetchPlayers])

  // Listen for chat messages from the server log tailer
  useEffect(() => {
    if (socket) {
      const handleSocketMessage = (data: { id?: string; type?: string; author?: string; message?: string; timestamp?: string; sourceChatType?: string }) => {
        const msg = data.message
        if (!msg) return
        setChatHistory(prev => {
             // Coalesce an optimistic local post with the echoed server log line
             // without dropping a legitimate repeated chat message from a player.
             const parsedTs = data.timestamp ? Date.parse(data.timestamp) : Number.NaN
             const incomingTs = Number.isFinite(parsedTs) ? parsedTs : Date.now()
             const recent = prev.slice(-20)
             const hasSameSocketId = data.id ? recent.some(m => m.id === data.id) : false
             const bracketedServerEcho = (data.type === 'server' || !data.type)
               ? msg.match(/^\[([^\]]+)\]\s+(.+)$/)
               : null
             const isOptimisticEcho = recent.some(m =>
               m.id.startsWith('local-') &&
               Math.abs(m.timestamp.getTime() - incomingTs) < 15000 &&
               (
                 (m.message === msg && m.author?.toLowerCase() === data.author?.toLowerCase()) ||
                 (bracketedServerEcho !== null &&
                   m.message === bracketedServerEcho[2] &&
                   m.author?.toLowerCase() === bracketedServerEcho[1].toLowerCase())
               )
             )
             if (hasSameSocketId || isOptimisticEcho) return prev

             const newMessage: ChatMessage = {
                id: data.id || `${incomingTs}-${Math.random().toString(36).slice(2, 8)}`,
                type: data.type || 'general',
                author: data.author,
                message: msg,
                timestamp: new Date(incomingTs),
                sourceChatType: data.sourceChatType,
             }

             return [...prev, newMessage].slice(-200)
        })
      }

      socket.on('chat:message', handleSocketMessage)
      return () => { socket.off('chat:message', handleSocketMessage) }
    }
  }, [socket])

  const sendMessage = async () => {
    if (!message.trim() || sendingRef.current || !canSendChat) return
    // This guard is the real gate -- it covers both the Send button's
    // onClick and the Enter-keydown path in handleKeyDown below, since both
    // call this same function. The disabled attribute on the Send button is
    // only the affordance (bug-hunt-2026-08-27 floor rule, from Angela's
    // Console.tsx Enter-key finding).
    sendingRef.current = true
    setSending(true)
    try {
      // Dispatch on the selected channel:
      //   server  → yellow broadcast banner (RCON servermsg)
      //   admin   → red admin-only chat (visible only to admins in-game)
      //   general → posts as a custom author into the public chat stream
      // Every branch below posts through the generic /panel-bridge/command
      // passthrough (or its chat-specific siblings), which only ever
      // resolves on success -- an in-game failure rejects the promise
      // instead (see teleportPlayerTo in WorldMap.tsx for the full
      // explanation) -- so this never sees result.success === false, only
      // the catch below.
      let localType: ChatMessage['type'] = 'server'
      let localAuthor = t('labels.server')
      if (channel === 'admin') {
        await panelBridgeApi.sendToAdminChat(message)
        localType = 'admin'
        localAuthor = t('labels.admin')
      } else if (channel === 'general') {
        await panelBridgeApi.sendToGeneralChat(message, GENERAL_CHAT_AUTHOR)
        localType = 'general'
        localAuthor = GENERAL_CHAT_AUTHOR
      } else {
        await panelBridgeApi.sendToServerChat(message, false)
      }

      const sentAt = new Date()
      setChatHistory(prev => [...prev, {
        id: `local-${sentAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
        type: localType,
        author: localAuthor,
        message: message,
        timestamp: sentAt
      }].slice(-200))
      // Sending always pins the user back to the bottom — they just
      // posted, so they want to see the result.
      stickToBottomRef.current = true
      setMessage('')
      toast({
        title:
          channel === 'admin' ? t('toasts.adminSentTitle')
          : channel === 'general' ? t('toasts.generalSentTitle')
          : t('toasts.broadcastSentTitle'),
        description:
          channel === 'admin' ? t('toasts.adminSentDesc')
          : channel === 'general' ? t('toasts.generalSentDesc')
          : t('toasts.broadcastSentDesc'),
        variant: 'success' as const,
      })
    } catch (error) {
      if (isBridgeNotRunning(error)) setBridgeOffline(true)
      toast({
        title: t('toasts.errorTitle'),
        description: getUserErrorMessage(error, t('toasts.sendFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  // Load saved chat presets from app settings; fall back to defaults.
  useEffect(() => {
    let cancelled = false
    configApi.getAppSettings()
      .then((settings: any) => {
        if (cancelled) return
        const saved = settings?.chatPresets
        if (Array.isArray(saved) && saved.every((p: unknown) => typeof p === 'string')) {
          setPresets(saved.length > 0 ? saved : defaultPresets)
        }
      })
      .catch(() => { /* fall back to defaults silently */ })
    return () => { cancelled = true }
  }, [defaultPresets])

  const persistPresets = useCallback(async (next: string[]) => {
    // The real gate for all three mutating preset actions (add, save-edit,
    // delete) -- each of handleAddPreset/handleSaveEdit/handleDeletePreset
    // calls this one function, including their Enter-key paths, so guarding
    // here covers every entry point rather than each caller individually.
    if (!canManagePresets) return
    let previous: string[] = []
    setPresets(prev => {
      previous = prev
      return next
    })
    try {
      await configApi.updateAppSettings({ chatPresets: next })
    } catch (error) {
      setPresets(previous)
      reportClientError('Failed to save chat presets.', error)
      toast({
        title: t('toasts.presetsSaveFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.unknownError')),
        variant: 'destructive',
      })
    }
  }, [toast, canManagePresets])

  const handleAddPreset = useCallback(() => {
    const trimmed = newPresetDraft.trim()
    if (!trimmed) return
    if (trimmed.length > 500) return
    persistPresets([...presets, trimmed])
    setNewPresetDraft('')
  }, [newPresetDraft, persistPresets, presets])

  const handleSaveEdit = useCallback(() => {
    if (editingIdx === null) return
    const trimmed = editingDraft.trim()
    if (!trimmed) return
    const next = presets.slice()
    next[editingIdx] = trimmed.slice(0, 500)
    persistPresets(next)
    setEditingIdx(null)
    setEditingDraft('')
  }, [editingDraft, editingIdx, persistPresets, presets])

  const handleDeletePreset = useCallback(async (idx: number) => {
    // Quick-broadcast presets are a shared, panel-wide setting (persisted
    // via configApi.updateAppSettings), not per-admin -- deleting one here
    // reaches every other admin who uses it, even though re-typing it back
    // is trivial. The "affects others but reversible" tier: warning-amber,
    // not destructive-red, not silent either.
    const ok = await confirm({
      title: t('quickBroadcasts.deleteConfirmTitle'),
      description: t('quickBroadcasts.deleteConfirmDescription', { preset: presets[idx] }),
      confirmLabel: t('quickBroadcasts.deleteConfirmButton'),
      variant: 'warning',
    })
    if (!ok) return
    const next = presets.filter((_, i) => i !== idx)
    persistPresets(next)
    if (editingIdx === idx) {
      setEditingIdx(null)
      setEditingDraft('')
    }
  }, [confirm, editingIdx, persistPresets, presets, t])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  // Each kind of line keeps its colour in a tint and its label, not in a
  // thick side stripe.
  const getMessageStyle = (type: string) => {
    if (type === 'server') return 'rounded-md bg-warning/10 px-3 py-2'
    if (type === 'admin')  return 'rounded-md bg-destructive/10 px-3 py-2'
    return 'rounded-md bg-muted/30 px-3 py-2'
  }

  // Ground-truthed against the PZ server jar (zombie/network/chat/ChatType,
  // zombie/network/chat/ChatServer -- 'Got message:' is the ONE log call
  // that logs every player-submitted chat room's message, whisper/faction/
  // safehouse/radio included, not just public talking) and the server's own
  // en/UI.json chat-title strings: chat=Private is a whisper between two
  // players, chat=Faction/Safehouse/Radio are similarly member-only rooms.
  // `type` only has 3 styling buckets (server/admin/general), so all four
  // land in 'general' -- without this tag they were rendered byte-for-byte
  // identical to an ordinary public chat line, with no way for an admin
  // reading the feed to tell a private whisper from something said in
  // public. Local/General/Say (and an unrecognized/undefined value) are
  // deliberately untagged: that IS plain public chat, the common case.
  const getChannelTag = (sourceChatType?: string) => {
    switch (sourceChatType) {
      case 'Private': return t('channelTags.whisper')
      case 'Faction': return t('channelTags.faction')
      case 'Safehouse': return t('channelTags.safehouse')
      case 'Radio': return t('channelTags.radio')
      case 'Shout': return t('channelTags.shout')
      default: return null
    }
  }

  const getMessageMeta = (msg: ChatMessage) => {
    if (msg.type === 'server') return { icon: <Megaphone className="h-3.5 w-3.5" aria-hidden="true" />, label: msg.author || t('labels.server'), labelClass: 'text-warning' }
    if (msg.type === 'admin')  return { icon: <Shield className="h-3.5 w-3.5" aria-hidden="true" />,    label: msg.author || t('labels.admin'),  labelClass: 'text-destructive' }
    const channelTag = getChannelTag(msg.sourceChatType)
    const baseLabel = msg.author || t('labels.player')
    return { icon: <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />, label: channelTag ? `${channelTag} ${baseLabel}` : baseLabel, labelClass: 'text-primary' }
  }

  const alerts: PageAlert[] = bridgeOffline
    ? [{
        id: 'bridge-offline',
        tone: 'warning',
        title: t('bridgeOffline.title'),
        description: t('bridgeOffline.description'),
        action: { label: t('bridgeOffline.action'), to: '/settings?tab=bridge' },
      }]
    : []

  return (
    // From lg up the page is exactly one screen tall (main's p-8 is the 4rem),
    // so the chat log fills what the header leaves and scrolls on its own.
    <div className="page-transition flex flex-col gap-6 lg:h-[calc(100dvh-4rem)] lg:min-h-[36rem]">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        actions={
          <Button variant="outline" size="sm" onClick={fetchPlayers} aria-label={t('pageHeader.refresh')} title={t('pageHeader.refresh')}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t('pageHeader.refresh')}</span>
          </Button>
        }
      />

      <PageAlerts alerts={alerts} />

      <div className="grid grid-cols-1 gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
        {/* The chat log and the composer. SectionCard's body is its last
            child: it becomes a flex column so the log takes the height. */}
        <SectionCard
          title={t('chatWindow.streamLabel')}
          icon={MessagesSquare}
          density="compact"
          flush
          status={
            <>
              <StatusPill
                tone={socket?.connected ? 'ok' : 'idle'}
                pulse={!!socket?.connected}
                size="sm"
                label={socket?.connected ? t('chatWindow.live') : t('chatWindow.offline')}
              />
              <span className="text-xs tabular-nums text-muted-foreground">{t('chatWindow.msgCount', { count: chatHistory.length })}</span>
            </>
          }
          className="flex h-[calc(100dvh-9rem)] min-h-[26rem] flex-col overflow-hidden lg:col-span-2 lg:h-auto lg:min-h-0 [&>div:last-child]:flex [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1 [&>div:last-child]:flex-col"
        >
          {/* Messages Area */}
          <ScrollArea className="min-h-0 flex-1 px-4" role="log" aria-live="polite" aria-label={t('chatWindow.messagesAria')}>
            <div className="space-y-2 py-3">
              {chatHistory.length === 0 ? (
                <EmptyState type="noMessages" title={t('emptyState.title')} description={t('emptyState.description')} compact />
              ) : (
                chatHistory.map((msg) => {
                  const meta = getMessageMeta(msg)
                  return (
                    <div key={msg.id} className={getMessageStyle(msg.type)}>
                      <div className="mb-0.5 flex items-center justify-between gap-3">
                        <span className={cn('flex min-w-0 items-center gap-1.5 text-xs font-medium', meta.labelClass)}>
                          {meta.icon}
                          {meta.label}
                        </span>
                        <time dateTime={msg.timestamp.toISOString()} className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatTime(msg.timestamp, { seconds: true })}
                        </time>
                      </div>
                      <p className="text-sm text-foreground [overflow-wrap:anywhere]">{msg.message}</p>
                    </div>
                  )
                })
              )}
              <div ref={chatEndRef} />
            </div>
          </ScrollArea>

          {/* Message Input */}
          <div className="shrink-0 border-t border-border/60 bg-muted/20 p-3 sm:p-4">
            {nativeChatAvailable !== null && (
              <p className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', nativeChatAvailable ? 'bg-success' : 'bg-warning')} aria-hidden="true" />
                {nativeChatAvailable ? t('deliveryStatus.native') : t('deliveryStatus.rconFallback')}
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="flex items-center gap-1.5">
                <Select value={channel} onValueChange={(v) => setChannel(v as ChatChannel)} disabled={sending}>
                  <SelectTrigger className="h-10 sm:w-52" aria-label={t('channel.aria')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="server">
                      <span className="flex items-center gap-2">
                        <Megaphone className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
                        {t('channel.server')}
                      </span>
                    </SelectItem>
                    <SelectItem value="admin">
                      <span className="flex items-center gap-2">
                        <Shield className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                        {t('channel.admin')}
                      </span>
                    </SelectItem>
                    <SelectItem value="general">
                      <span className="flex items-center gap-2">
                        <MessageSquare className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                        {t('channel.general')}
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <HelpTip label={t('channel.aria')}>{t('channel.tip', { adminLabel: GENERAL_CHAT_AUTHOR })}</HelpTip>
              </div>
              <Input
                ref={messageInputRef}
                placeholder={
                  channel === 'admin'
                    ? t('input.placeholderAdmin')
                    : channel === 'general'
                      ? t('input.placeholderGeneral')
                      : t('input.placeholderServer')
                }
                aria-label={t('input.aria')}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={sending}
                maxLength={500}
                className="h-10 flex-1"
              />
              <DisabledReason reason={!canSendChat ? t('input.noPermission') : null}>
                <Button
                  variant="command"
                  onClick={sendMessage}
                  disabled={sending || !message.trim() || !canSendChat}
                  className="h-10 min-w-24 gap-1.5"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
                  {t('input.sendButton')}
                </Button>
              </DisabledReason>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>
                {channel === 'admin'
                  ? t('footer.adminOnly')
                  : players.length === 0
                    ? t('footer.noPlayersOnline')
                    : t('footer.broadcastingTo', { count: players.length })}
              </span>
              <span className={cn('shrink-0 tabular-nums', message.length > 450 && 'text-warning')}>
                {message.length}/500
              </span>
            </div>
          </div>
        </SectionCard>

        <div className="space-y-6 lg:min-h-0 lg:overflow-y-auto">
          {/* Online players: each opens in Players. */}
          <SectionCard
            title={t('playersPanel.label')}
            icon={Users}
            density="compact"
            flush
            status={<span className="text-xs tabular-nums text-muted-foreground">{t('playersPanel.onlineCount', { count: players.length })}</span>}
          >
            <div className="p-2">
              {players.length === 0 ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  {t('playersPanel.noPlayersConnected')}
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {players.map((player) => (
                    <li key={player.name}>
                      <Link
                        to={`/players?player=${encodeURIComponent(player.name)}`}
                        title={t('playersPanel.openPlayer', { name: player.name })}
                        className="flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
                        <span className="truncate">{player.name}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </SectionCard>

          {/* Quick broadcasts: the panel's one shared preset list. */}
          <SectionCard
            title={t('quickBroadcasts.label')}
            description={t('quickBroadcasts.description')}
            icon={Megaphone}
            density="compact"
            flush
            actions={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPresetsEditing((v) => !v)
                  setEditingIdx(null)
                  setEditingDraft('')
                  setNewPresetDraft('')
                }}
                aria-label={presetsEditing ? t('quickBroadcasts.doneAria') : t('quickBroadcasts.editAria')}
              >
                {presetsEditing ? <Check aria-hidden="true" /> : <Pencil aria-hidden="true" />}
                {presetsEditing ? t('quickBroadcasts.done') : t('quickBroadcasts.edit')}
              </Button>
            }
          >
            <div className="space-y-1.5 p-2">
              {presets.length === 0 && !presetsEditing && (
                <p className="px-2 py-2 text-sm text-muted-foreground">{t('quickBroadcasts.noPresets')}</p>
              )}
              {presets.map((quickMsg, idx) => {
                const isEditing = presetsEditing && editingIdx === idx
                if (isEditing) {
                  return (
                    <div key={`edit-${idx}`} className="flex items-center gap-1">
                      <Input
                        value={editingDraft}
                        onChange={(e) => setEditingDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); handleSaveEdit() }
                          if (e.key === 'Escape') { setEditingIdx(null); setEditingDraft('') }
                        }}
                        maxLength={500}
                        autoFocus
                        className="h-9 flex-1 text-sm"
                      />
                      <DisabledReason reason={!canManagePresets ? t('quickBroadcasts.noPermission') : null}>
                        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={handleSaveEdit} disabled={!canManagePresets || !editingDraft.trim()} aria-label={t('quickBroadcasts.saveAria')}>
                          <Check className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </DisabledReason>
                      <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => { setEditingIdx(null); setEditingDraft('') }} aria-label={t('quickBroadcasts.cancelAria')}>
                        <X className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  )
                }
                return (
                  <div key={`preset-${idx}`} className="flex items-center gap-1">
                    <button
                      type="button"
                      className="min-h-9 flex-1 whitespace-normal rounded-md bg-muted/20 px-2.5 py-1.5 text-start text-sm text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                      onClick={() => {
                        if (presetsEditing) {
                          setEditingIdx(idx)
                          setEditingDraft(quickMsg)
                        } else {
                          setMessage(quickMsg)
                          messageInputRef.current?.focus()
                        }
                      }}
                    >
                      {quickMsg}
                    </button>
                    {presetsEditing && (
                      <DisabledReason reason={!canManagePresets ? t('quickBroadcasts.noPermission') : null}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-destructive hover:text-destructive"
                          onClick={() => handleDeletePreset(idx)}
                          disabled={!canManagePresets}
                          aria-label={t('quickBroadcasts.deleteAria', { index: idx + 1 })}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </DisabledReason>
                    )}
                  </div>
                )
              })}
              {presetsEditing && (
                <div className="mt-1 flex items-center gap-1 border-t border-border/40 pt-2">
                  <Input
                    placeholder={t('quickBroadcasts.addPlaceholder')}
                    value={newPresetDraft}
                    onChange={(e) => setNewPresetDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); handleAddPreset() }
                    }}
                    maxLength={500}
                    className="h-9 flex-1 text-sm"
                  />
                  <DisabledReason reason={!canManagePresets ? t('quickBroadcasts.noPermission') : null}>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9"
                      onClick={handleAddPreset}
                      disabled={!newPresetDraft.trim() || !canManagePresets}
                      aria-label={t('quickBroadcasts.addAria')}
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </DisabledReason>
                </div>
              )}
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  )
}
