import { useState, useEffect, useCallback, useRef } from 'react'
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
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'
import { useSocket } from '@/contexts/SocketContext'
import { EmptyState } from '@/components/EmptyState'
import { cn } from '@/lib/utils'
import { reportClientError } from '@/lib/client-errors'

interface ChatMessage {
  id: string
  type: string
  author?: string
  message: string
  timestamp: Date
}

interface Player {
  name: string
}

type ChatChannel = 'server' | 'admin' | 'general'

const DEFAULT_PRESETS = [
  'Server will restart in 5 minutes!',
  'Welcome to the server!',
  'Please read the rules at /rules',
  'Server maintenance starting soon',
  'Have fun and stay safe!',
]

export default function Chat() {
  const [message, setMessage] = useState('')
  const [players, setPlayers] = useState<Player[]>([])
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [channel, setChannel] = useState<ChatChannel>('server')
  const [presets, setPresets] = useState<string[]>(DEFAULT_PRESETS)
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
  const socket = useSocket()

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

  const fetchPlayers = useCallback(async () => {
    try {
      const data = await playersApi.getPlayers()
      if (data.players) {
        setPlayers(data.players)
      }
    } catch (error) {
      reportClientError('Failed to fetch players.', error)
    }
  }, [])

  useEffect(() => {
    fetchPlayers()
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      fetchPlayers()
    }, 15000)
    return () => clearInterval(interval)
  }, [fetchPlayers])

  // Listen for chat messages from the server log tailer
  useEffect(() => {
    if (socket) {
      const handleSocketMessage = (data: { id?: string; type?: string; author?: string; message?: string; timestamp?: string }) => {
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
                timestamp: new Date(incomingTs)
             }

             return [...prev, newMessage].slice(-200)
        })
      }

      socket.on('chat:message', handleSocketMessage)
      return () => { socket.off('chat:message', handleSocketMessage) }
    }
  }, [socket])

  const sendMessage = async () => {
    if (!message.trim() || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    try {
      // Dispatch on the selected channel:
      //   server  → yellow broadcast banner (RCON servermsg)
      //   admin   → red admin-only chat (visible only to admins in-game)
      //   general → posts as a custom author into the public chat stream
      let result: { success?: boolean; error?: string } | undefined
      let localType: ChatMessage['type'] = 'server'
      let localAuthor = 'Server'
      if (channel === 'admin') {
        result = await panelBridgeApi.sendToAdminChat(message)
        localType = 'admin'
        localAuthor = 'Admin'
      } else if (channel === 'general') {
        result = await panelBridgeApi.sendToGeneralChat(message, 'Admin')
        localType = 'general'
        localAuthor = 'Admin'
      } else {
        result = await panelBridgeApi.sendToServerChat(message, false)
      }

      if (result?.success) {
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
            channel === 'admin' ? 'Admin Message Sent'
            : channel === 'general' ? 'Posted to Chat'
            : 'Broadcast Sent',
          description:
            channel === 'admin' ? 'Visible only to admins in-game.'
            : channel === 'general' ? 'Posted into the public chat stream.'
            : 'Message delivered to all connected players.',
          variant: 'success' as const,
        })
      } else {
        throw new Error(result?.error || 'Failed to send message')
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to send message',
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
          setPresets(saved.length > 0 ? saved : DEFAULT_PRESETS)
        }
      })
      .catch(() => { /* fall back to defaults silently */ })
    return () => { cancelled = true }
  }, [])

  const persistPresets = useCallback(async (next: string[]) => {
    setPresets(next)
    try {
      await configApi.updateAppSettings({ chatPresets: next })
    } catch (error) {
      reportClientError('Failed to save chat presets.', error)
      toast({
        title: 'Could not save presets',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    }
  }, [toast])

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

  const handleDeletePreset = useCallback((idx: number) => {
    const next = presets.filter((_, i) => i !== idx)
    persistPresets(next)
    if (editingIdx === idx) {
      setEditingIdx(null)
      setEditingDraft('')
    }
  }, [editingIdx, persistPresets, presets])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const getMessageStyle = (type: string) => {
    if (type === 'server') return 'border-l-2 border-amber-400/70 bg-amber-400/5 pl-3 pr-3 py-2'
    if (type === 'admin')  return 'border-l-2 border-destructive/70 bg-destructive/5 pl-3 pr-3 py-2'
    return 'border-l-2 border-primary/55 bg-muted/15 pl-3 pr-3 py-2'
  }

  const getMessageMeta = (msg: ChatMessage) => {
    if (msg.type === 'server') return { icon: <Megaphone className="w-3 h-3" />, label: msg.author || 'Server', labelClass: 'text-amber-400', dotClass: 'bg-amber-400/80' }
    if (msg.type === 'admin')  return { icon: <Shield className="w-3 h-3" />,    label: msg.author || 'Admin',  labelClass: 'text-destructive', dotClass: 'bg-destructive/80' }
    return { icon: <MessageSquare className="w-3 h-3" />, label: msg.author || 'Player', labelClass: 'text-primary', dotClass: 'bg-primary/80' }
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title="In-Game Chat"
        description="Broadcast messages to all connected players and see their chat in real time."
        icon={<MessagesSquare className="w-5 h-5" />}
        actions={
          <Button variant="outline" size="sm" onClick={fetchPlayers} className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Chat Window */}
        <div className="lg:col-span-2">
          <div className="relative h-[calc(100vh-260px)] min-h-[420px] flex flex-col rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg overflow-hidden">
            {/* corner brackets */}
            <div aria-hidden className="absolute top-1 left-1 w-2.5 h-2.5 border-l-2 border-t-2 border-primary/45 pointer-events-none z-10" />
            <div aria-hidden className="absolute top-1 right-1 w-2.5 h-2.5 border-r-2 border-t-2 border-primary/45 pointer-events-none z-10" />
            <div aria-hidden className="absolute bottom-1 left-1 w-2.5 h-2.5 border-l-2 border-b-2 border-primary/45 pointer-events-none z-10" />
            <div aria-hidden className="absolute bottom-1 right-1 w-2.5 h-2.5 border-r-2 border-b-2 border-primary/45 pointer-events-none z-10" />

            {/* header strip */}
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] select-none shrink-0">
              <span className="flex items-center gap-1.5 text-primary/70">
                <MessagesSquare className="w-3 h-3" />
                <span>chat stream</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                <span className="text-muted-foreground/80 normal-case tracking-normal tabular-nums">{chatHistory.length} {chatHistory.length === 1 ? 'msg' : 'msgs'}</span>
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground/60">
                <span className={cn('w-1.5 h-1.5 rounded-full', socket?.connected ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground/40')} />
                <span>{socket?.connected ? 'LIVE' : 'OFFLINE'}</span>
              </span>
            </div>

            <div className="flex-1 flex flex-col p-0 min-h-0">
              {/* Messages Area */}
              <ScrollArea className="flex-1 px-3" role="log" aria-live="polite" aria-label="Chat messages">
                <div className="py-3 space-y-2">
                  {chatHistory.length === 0 ? (
                    <EmptyState type="noMessages" title="No chat messages yet" description="Player messages and your broadcasts will appear here in real time." compact />
                  ) : (
                    chatHistory.map((msg) => {
                      const meta = getMessageMeta(msg)
                      return (
                        <div key={msg.id} className={getMessageStyle(msg.type)}>
                          <div className="flex items-center justify-between mb-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', meta.dotClass)} />
                              <span className={cn('font-mono text-[10px] uppercase tracking-[0.18em] flex items-center gap-1', meta.labelClass)}>
                                {meta.icon}
                                {meta.label}
                              </span>
                            </div>
                            <time dateTime={msg.timestamp.toISOString()} className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
                              {msg.timestamp.toLocaleTimeString()}
                            </time>
                          </div>
                          <p className="text-sm text-foreground/90 [overflow-wrap:anywhere]">{msg.message}</p>
                        </div>
                      )
                    })
                  )}
                  <div ref={chatEndRef} />
                </div>
              </ScrollArea>

              {/* Message Input */}
              <div className="p-3 border-t border-border/50 bg-muted/20">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select value={channel} onValueChange={(v) => setChannel(v as ChatChannel)} disabled={sending}>
                    <SelectTrigger className="h-10 sm:w-52 font-mono text-[11px] uppercase tracking-[0.16em] bg-card/70 border-border/55" aria-label="Chat channel">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="server">
                        <span className="flex items-center gap-2">
                          <Megaphone className="w-3.5 h-3.5 text-amber-400" />
                          Server broadcast
                        </span>
                      </SelectItem>
                      <SelectItem value="admin">
                        <span className="flex items-center gap-2">
                          <Shield className="w-3.5 h-3.5 text-destructive" />
                          Admin chat
                        </span>
                      </SelectItem>
                      <SelectItem value="general">
                        <span className="flex items-center gap-2">
                          <MessageSquare className="w-3.5 h-3.5 text-primary" />
                          General chat
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    ref={messageInputRef}
                    placeholder={
                      channel === 'admin'
                        ? 'admins only — press enter to send…'
                        : channel === 'general'
                          ? 'post as Admin — press enter to send…'
                          : 'broadcast to all players — press enter to send…'
                    }
                    aria-label="Chat message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={sending}
                    maxLength={500}
                    className="h-10 flex-1 bg-card/70 border-border/55 focus-visible:border-primary/60"
                  />
                  <Button
                    onClick={sendMessage}
                    disabled={sending || !message.trim()}
                    className="h-10 min-w-20 sm:min-w-24 gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em]"
                  >
                    {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Send className="w-3.5 h-3.5" />send</>}
                  </Button>
                </div>
                <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/65">
                  <span>
                    {channel === 'admin'
                      ? 'admins only — hidden from regular players'
                      : players.length === 0
                        ? 'no players online — server log only'
                        : `broadcasting to ${players.length} ${players.length === 1 ? 'player' : 'players'}`}
                  </span>
                  <span className={cn('tabular-nums', message.length > 450 ? 'text-amber-400' : '')}>
                    {message.length}/500
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Online Players */}
          <div className="relative rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-md overflow-hidden">
            <div aria-hidden className="absolute top-1 left-1 w-2 h-2 border-l-2 border-t-2 border-primary/40 pointer-events-none" />
            <div aria-hidden className="absolute top-1 right-1 w-2 h-2 border-r-2 border-t-2 border-primary/40 pointer-events-none" />
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] select-none">
              <span className="flex items-center gap-1.5 text-primary/70">
                <Users className="w-3 h-3" />
                <span>players</span>
              </span>
              <span className="text-muted-foreground/70 tabular-nums normal-case tracking-normal">{players.length} online</span>
            </div>
            <div className="p-2">
              {players.length === 0 ? (
                <div className="px-2 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60 italic">
                  no players connected
                </div>
              ) : (
                <div className="space-y-1">
                  {players.map((player) => (
                    <div key={player.name} className="flex items-center gap-2 px-2 py-1.5 rounded-sm border-l-2 border-transparent hover:border-primary/50 hover:bg-muted/40 transition-colors min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 animate-pulse" aria-hidden="true" />
                      <span className="text-xs font-medium text-foreground/90 truncate">{player.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Quick Messages */}
          <div className="relative rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-md overflow-hidden">
            <div aria-hidden className="absolute top-1 left-1 w-2 h-2 border-l-2 border-t-2 border-amber-400/40 pointer-events-none" />
            <div aria-hidden className="absolute top-1 right-1 w-2 h-2 border-r-2 border-t-2 border-amber-400/40 pointer-events-none" />
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] select-none">
              <span className="flex items-center gap-1.5 text-amber-400/80">
                <Megaphone className="w-3 h-3" />
                <span>quick broadcasts</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 -my-1 font-mono text-[10px] uppercase tracking-[0.16em]"
                onClick={() => {
                  setPresetsEditing((v) => !v)
                  setEditingIdx(null)
                  setEditingDraft('')
                  setNewPresetDraft('')
                }}
                aria-label={presetsEditing ? 'Done editing presets' : 'Edit presets'}
              >
                {presetsEditing ? <><Check className="w-3 h-3 mr-1" />done</> : <><Pencil className="w-3 h-3 mr-1" />edit</>}
              </Button>
            </div>
            <div className="p-2 space-y-1.5">
              {presets.length === 0 && !presetsEditing && (
                <p className="px-2 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">// no presets — click edit to add</p>
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
                      <Button variant="ghost" size="icon" className="h-9 w-9" onClick={handleSaveEdit} aria-label="Save">
                        <Check className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => { setEditingIdx(null); setEditingDraft('') }} aria-label="Cancel">
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  )
                }
                return (
                  <div key={`preset-${idx}`} className="flex items-center gap-1">
                    <button
                      type="button"
                      className="group flex-1 min-h-9 px-2 py-1.5 text-left rounded-sm border-l-2 border-transparent bg-muted/15 hover:border-amber-400/60 hover:bg-muted/40 focus-visible:border-amber-400/60 focus-visible:outline-none transition-colors text-xs text-foreground/85 whitespace-normal"
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
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-destructive hover:text-destructive"
                        onClick={() => handleDeletePreset(idx)}
                        aria-label={`Delete preset ${idx + 1}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                )
              })}
              {presetsEditing && (
                <div className="flex items-center gap-1 pt-2 mt-1 border-t border-border/40">
                  <Input
                    placeholder="add a new quick message…"
                    value={newPresetDraft}
                    onChange={(e) => setNewPresetDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); handleAddPreset() }
                    }}
                    maxLength={500}
                    className="h-9 flex-1 text-sm bg-card/70 border-border/55"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={handleAddPreset}
                    disabled={!newPresetDraft.trim()}
                    aria-label="Add preset"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
