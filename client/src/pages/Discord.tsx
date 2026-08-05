import { useState, useEffect, useCallback, useRef } from "react";
import { copyText } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { discordApi } from "@/lib/api";
import { useConfirm } from "@/contexts/ConfirmContext";
import {
  MessageSquare,
  Bot,
  Play,
  Square,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Eye,
  EyeOff,
  Send,
  ExternalLink,
  Shield,
  Hash,
  Server,
  Bell,
  Copy,
  Check,
  ChevronRight,
  ChevronLeft,
  Zap,
  Settings,
  ArrowRight,
  ToggleLeft,
  UserPlus,
  MessagesSquare,
  Users,
  Lock,
  Trash2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

interface DiscordStatus {
  running: boolean;
  configured: boolean;
  connected?: boolean;
  username?: string;
  error?: string;
}

interface DiscordConfig {
  token: string | null;
  hasToken: boolean;
  guildId: string;
  adminRoleId: string;
  modRoleId: string;
  channelId: string;
  autoStart: boolean;
  chatRelayEnabled: boolean;
  chatRelayChannelId: string;
  chatRelayScope: "public" | "general";
}

interface BotInfo {
  username: string;
  id: string;
  discriminator: string;
  avatar: string | null;
}

interface WebhookEvent {
  enabled: boolean;
  template: string;
}

type WebhookEvents = Record<string, WebhookEvent>;
type FlashMessage = { type: "success" | "error"; text: string };

// Small helper to copy text to clipboard
function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = () => {
    copyText(text);
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };
  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCopy}
      className="gap-1.5 shrink-0"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-primary" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
      {label || (copied ? "Copied!" : "Copy")}
    </Button>
  );
}

function InlineFeedback({
  message,
  className,
}: {
  message: FlashMessage | null;
  className?: string;
}) {
  if (!message) return null;

  return (
    <Alert
      variant={message.type === "error" ? "destructive" : "default"}
      className={className}
    >
      {message.type === "error" ? (
        <AlertCircle className="h-4 w-4" />
      ) : (
        <CheckCircle2 className="h-4 w-4" />
      )}
      <AlertTitle>{message.type === "error" ? "Error" : "Success"}</AlertTitle>
      <AlertDescription>{message.text}</AlertDescription>
    </Alert>
  );
}

const eventLabels: Record<
  string,
  {
    label: string;
    description: string;
    variables: string;
    defaultTemplate: string;
  }
> = {
  serverStart: {
    label: "Server Start",
    description: "When server starts",
    variables: "None",
    defaultTemplate: "🟢 **Server is online**",
  },
  serverStop: {
    label: "Server Stop",
    description: "When server stops",
    variables: "None",
    defaultTemplate: "🔴 **Server is offline**",
  },
  playerJoin: {
    label: "Player Join",
    description: "When a player connects",
    variables: "{player}",
    defaultTemplate: "👋 **{player}** joined the server",
  },
  playerLeave: {
    label: "Player Leave",
    description: "When a player disconnects",
    variables: "{player}",
    defaultTemplate: "👋 **{player}** left the server",
  },
  scheduledRestart: {
    label: "Scheduled Restart",
    description: "Before scheduled restart",
    variables: "{minutes}",
    defaultTemplate: "🔄 **Server restarting** in {minutes} minute(s)",
  },
  backupComplete: {
    label: "Backup Complete",
    description: "After backup finishes",
    variables: "None",
    defaultTemplate: "💾 **Backup complete**",
  },
  playerDeath: {
    label: "Player Death",
    description: "When a player dies",
    variables: "{player}, {location}, {x}, {y}, {z}, {pvp}",
    defaultTemplate: "💀 **{player}** died at {location}",
  },
};

const SETUP_STEPS = [
  { label: "Create App", icon: Zap },
  { label: "Bot Token", icon: Bot },
  { label: "Intents", icon: ToggleLeft },
  { label: "Invite Bot", icon: UserPlus },
  { label: "Server IDs", icon: Hash },
  { label: "Launch", icon: Play },
];

export default function Discord() {
  const confirm = useConfirm();
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [config, setConfig] = useState<DiscordConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [webhookEvents, setWebhookEvents] = useState<WebhookEvents>({});
  const [savingEvents, setSavingEvents] = useState(false);
  const [autoStart, setAutoStart] = useState(true);
  const [commandPermissions, setCommandPermissions] = useState<
    Record<string, string>
  >({});
  const [savingPermissions, setSavingPermissions] = useState(false);

  // Form state
  const [token, setToken] = useState("");
  const [guildId, setGuildId] = useState("");
  const [adminRoleId, setAdminRoleId] = useState("");
  const [modRoleId, setModRoleId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [chatRelayEnabled, setChatRelayEnabled] = useState(true);
  const [chatRelayChannelId, setChatRelayChannelId] = useState("");
  const [chatRelayScope, setChatRelayScope] = useState<"public" | "general">(
    "public",
  );

  // Setup wizard state
  const [configMessage, setConfigMessage] = useState<FlashMessage | null>(null);
  const [eventsMessage, setEventsMessage] = useState<FlashMessage | null>(null);
  const [permissionsMessage, setPermissionsMessage] =
    useState<FlashMessage | null>(null);

  const [setupStep, setSetupStep] = useState(0);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      let configFailed = false;
      const [statusData, configData, eventsData, permsData] = await Promise.all(
        [
          discordApi
            .getStatus()
            .catch(() => ({ running: false, configured: false })),
          discordApi.getConfig().catch(() => {
            configFailed = true;
            return null;
          }),
          discordApi.getWebhookEvents().catch(() => ({ events: {} })),
          discordApi.getPermissions().catch(() => ({ permissions: {} })),
        ],
      );

      setStatus(statusData);
      setWebhookEvents(eventsData.events || {});
      setCommandPermissions(permsData.permissions || {});

      // Keep the last known config on a failed read. Clearing it made a fully
      // configured bot look like a first-time setup, inviting the user to
      // retype everything.
      if (configFailed) {
        setConfigMessage({
          type: "error",
          text: "Could not read the Discord configuration. Nothing has been changed — refresh to try again.",
        });
        return;
      }

      setConfig(configData);

      if (configData) {
        setGuildId(configData.guildId || "");
        setAdminRoleId(configData.adminRoleId || "");
        setModRoleId(configData.modRoleId || "");
        setChannelId(configData.channelId || "");
        setChatRelayEnabled(configData.chatRelayEnabled !== false);
        setChatRelayChannelId(configData.chatRelayChannelId || "");
        setChatRelayScope(
          configData.chatRelayScope === "general" ? "general" : "public",
        );
        setAutoStart(configData.autoStart !== false);
      }
    } catch {
      setConfigMessage({
        type: "error",
        text: "Failed to load Discord configuration. Refresh and try again.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Poll for bot status every 20s to catch silent disconnects without a full reload.
  useEffect(() => {
    const pollId = setInterval(async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const nextStatus = await discordApi.getStatus().catch(() => null);
        if (nextStatus) setStatus(nextStatus as DiscordStatus);
      } catch {
        // Ignore transient polling failures and keep the last known status visible.
      }
    }, 20000);

    return () => clearInterval(pollId);
  }, []);

  // Discord ID validation (snowflake format). The range matches the server's
  // validator in routes/discord.js — a narrower one here rejects IDs the API
  // would have accepted.
  const isValidDiscordId = (id: string): boolean => {
    if (!id) return true; // Empty is allowed for optional fields
    return /^\d{15,21}$/.test(id);
  };

  const hasGuildIdError = Boolean(guildId && !isValidDiscordId(guildId));
  const hasChannelIdError = Boolean(channelId && !isValidDiscordId(channelId));
  const hasAdminRoleIdError = Boolean(
    adminRoleId && !isValidDiscordId(adminRoleId),
  );
  const hasModRoleIdError = Boolean(modRoleId && !isValidDiscordId(modRoleId));
  const hasChatRelayChannelIdError = Boolean(
    chatRelayChannelId && !isValidDiscordId(chatRelayChannelId),
  );
  const hasConfigValidationError =
    hasGuildIdError ||
    hasChannelIdError ||
    hasAdminRoleIdError ||
    hasModRoleIdError ||
    hasChatRelayChannelIdError;
  const canSaveConfig = Boolean(
    guildId && (token || config?.hasToken) && !hasConfigValidationError,
  );

  const handleSaveConfig = async (andStart = false) => {
    try {
      setSaving(true);
      setConfigMessage(null);

      if (!token && !config?.hasToken) {
        setConfigMessage({ type: "error", text: "Bot token is required" });
        return;
      }

      if (!guildId) {
        setConfigMessage({ type: "error", text: "Guild ID is required" });
        return;
      }

      if (!isValidDiscordId(guildId)) {
        setConfigMessage({
          type: "error",
          text: "Invalid Guild ID format (should be 17-19 digit number)",
        });
        return;
      }

      if (channelId && !isValidDiscordId(channelId)) {
        setConfigMessage({
          type: "error",
          text: "Invalid Channel ID format (should be 17-19 digit number)",
        });
        return;
      }

      if (adminRoleId && !isValidDiscordId(adminRoleId)) {
        setConfigMessage({
          type: "error",
          text: "Invalid Admin Role ID format (should be 17-19 digit number)",
        });
        return;
      }

      if (modRoleId && !isValidDiscordId(modRoleId)) {
        setConfigMessage({
          type: "error",
          text: "Invalid Moderator Role ID format (should be 17-19 digit number)",
        });
        return;
      }

      const tokenToSave = token || "KEEP_EXISTING";

      await discordApi.updateConfig(
        tokenToSave,
        guildId,
        adminRoleId || undefined,
        channelId || undefined,
        autoStart,
        modRoleId || undefined,
        chatRelayEnabled,
        chatRelayChannelId || undefined,
        chatRelayScope,
      );

      if (andStart) {
        try {
          await discordApi.start();
        } catch (startError: unknown) {
          // The config did save — say so, rather than implying it was lost.
          const why =
            startError instanceof Error ? startError.message : "unknown error";
          setConfigMessage({
            type: "error",
            text: `Configuration saved, but the bot failed to start: ${why}`,
          });
          await loadData();
          return;
        }
        setConfigMessage({
          type: "success",
          text: "Configuration saved and bot started!",
        });
      } else {
        setConfigMessage({
          type: "success",
          text: "Discord configuration saved successfully",
        });
      }
      setToken("");
      await loadData();
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Failed to save configuration";
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setSaving(false);
    }
  };

  const handleTestToken = async () => {
    try {
      setTesting(true);
      setConfigMessage(null);
      setBotInfo(null);
      setInviteUrl(null);

      if (!token) {
        setConfigMessage({ type: "error", text: "Enter a token to test" });
        return;
      }

      const result = await discordApi.testToken(token);
      setBotInfo(result.bot);
      setInviteUrl(result.inviteUrl || null);
      setConfigMessage({
        type: "success",
        text: `Token valid! Bot: ${result.bot.username}`,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Invalid token";
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setTesting(false);
    }
  };

  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleStart = async () => {
    if (starting) return;
    try {
      setStarting(true);
      setConfigMessage(null);
      await discordApi.start();
      setConfigMessage({ type: "success", text: "Discord bot started" });
      await loadData();
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Failed to start bot";
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    if (stopping) return;
    try {
      setStopping(true);
      setConfigMessage(null);
      await discordApi.stop();
      setConfigMessage({ type: "success", text: "Discord bot stopped" });
      await loadData();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to stop bot";
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setStopping(false);
    }
  };

  const handleSendTestMessage = async () => {
    if (sendingTest) return;
    try {
      setSendingTest(true);
      setConfigMessage(null);
      await discordApi.sendTestMessage();
      setConfigMessage({
        type: "success",
        text: "Test message sent to Discord channel",
      });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Failed to send test message";
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setSendingTest(false);
    }
  };

  const handleResetConfig = async () => {
    if (resetting) return;

    const confirmed = await confirm({
      title: "Wipe Discord bot settings?",
      description:
        "This clears the saved bot token, guild and channel IDs, role IDs, chat relay settings, command permissions, and Discord event notification setup. The bot will stop and the page will return to first-time setup.",
      confirmLabel: "Wipe Discord Settings",
      destructive: true,
    });

    if (!confirmed) return;

    try {
      setResetting(true);
      setConfigMessage(null);
      await discordApi.resetConfig();
      setToken("");
      setGuildId("");
      setAdminRoleId("");
      setModRoleId("");
      setChannelId("");
      setChatRelayEnabled(true);
      setChatRelayChannelId("");
      setChatRelayScope("public");
      setAutoStart(true);
      setBotInfo(null);
      setInviteUrl(null);
      setWebhookEvents({});
      setCommandPermissions({});
      setSetupStep(0);
      setConfigMessage({
        type: "success",
        text: "Discord bot settings wiped. You can start setup from scratch.",
      });
      await loadData();
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? error.message
          : "Failed to wipe Discord settings";
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setResetting(false);
    }
  };

  const handleToggleEvent = (eventKey: string, enabled: boolean) => {
    setWebhookEvents((prev) => {
      // An enabled event with a blank template sends an empty message, which
      // Discord rejects — fall back to the default wording instead.
      const template =
        prev[eventKey]?.template?.trim() ||
        (enabled ? eventLabels[eventKey]?.defaultTemplate || "" : "");
      return { ...prev, [eventKey]: { ...prev[eventKey], enabled, template } };
    });
  };

  const handleUpdateTemplate = (eventKey: string, template: string) => {
    setWebhookEvents((prev) => ({
      ...prev,
      [eventKey]: { ...prev[eventKey], template },
    }));
  };

  const handleSaveWebhookEvents = async () => {
    try {
      setSavingEvents(true);
      await discordApi.updateWebhookEvents(webhookEvents);
      setEventsMessage({ type: "success", text: "Webhook events saved" });
      await loadData();
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? error.message
          : "Failed to save webhook events";
      setEventsMessage({ type: "error", text: msg });
    } finally {
      setSavingEvents(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ─── Determine if we should show setup wizard ───
  const isConfigured = config?.hasToken && config?.guildId;
  const showSetupWizard = !isConfigured && !status?.running;

  // ═════════════════════════════════════════════════
  // SETUP WIZARD — shown when bot is not yet configured
  // ═════════════════════════════════════════════════
  if (showSetupWizard) {
    return (
      <div className="space-y-6 page-transition">
        <PageHeader
          title="Discord Bot Setup"
          description="Let's get your Discord bot up and running — follow the steps below"
          icon={<MessageSquare className="w-5 h-5" />}
        />

        {/* Status Message */}
        <InlineFeedback message={configMessage} />

        {/* Stepper */}
        <div className="flex items-center justify-between overflow-x-auto gap-1">
          {SETUP_STEPS.map((step, i) => {
            const Icon = step.icon;
            const isActive = i === setupStep;
            const isDone = i < setupStep;
            return (
              <div key={i} className="flex items-center flex-1 last:flex-none">
                <button
                  onClick={() => setSetupStep(i)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-sm font-medium shrink-0 ${
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : isDone
                        ? "bg-primary/10 text-primary hover:bg-primary/15"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}
                >
                  {isDone ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <Icon className="w-4 h-4" />
                  )}
                  <span className="hidden md:inline">{step.label}</span>
                </button>
                {i < SETUP_STEPS.length - 1 && (
                  <div
                    className={`flex-1 h-px mx-2 ${isDone ? "bg-primary/30" : "bg-border"}`}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Step Content */}
        <Card>
          <CardContent className="pt-6">
            {/* ── Step 0: Create Application ── */}
            {setupStep === 0 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Zap className="w-5 h-5 text-primary" />
                    Create a Discord Application
                  </h3>
                  <p className="text-muted-foreground">
                    First, you need to create an application on Discord's
                    Developer Portal. This only takes a minute.
                  </p>
                </div>

                <div className="space-y-4 pl-1">
                  <div className="flex items-start gap-3">
                    <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-bold shrink-0 mt-0.5">
                      1
                    </div>
                    <div>
                      <p className="font-medium">
                        Open the Discord Developer Portal
                      </p>
                      <p className="text-sm text-muted-foreground mb-2">
                        Click the button below to open it in a new tab.
                      </p>
                      <Button variant="outline" asChild>
                        <a
                          href="https://discord.com/developers/applications"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="w-4 h-4 mr-2" /> Open
                          Developer Portal{" "}
                          <span className="sr-only">(opens in new tab)</span>
                        </a>
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-bold shrink-0 mt-0.5">
                      2
                    </div>
                    <div>
                      <p className="font-medium">Click "New Application"</p>
                      <p className="text-sm text-muted-foreground">
                        It's in the top-right corner. Name it anything you like
                        (e.g. "PZ Server Bot").
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-bold shrink-0 mt-0.5">
                      3
                    </div>
                    <div>
                      <p className="font-medium">Go to the "Bot" section</p>
                      <p className="text-sm text-muted-foreground">
                        In the left sidebar of your new application, click{" "}
                        <strong>Bot</strong>. Discord may auto-create a bot
                        user, or you may see an "Add Bot" button — click it if
                        so.
                      </p>
                    </div>
                  </div>
                </div>

                <Alert className="border-border/60 bg-muted/40 text-sm">
                  <Bot className="h-4 w-4 text-primary" />
                  <AlertTitle>Why do I need a bot?</AlertTitle>
                  <AlertDescription>
                    A Discord bot lets your panel send messages, register slash
                    commands, and bridge in-game chat to a Discord channel. It
                    runs through this panel, so you do not need separate
                    hosting.
                  </AlertDescription>
                </Alert>

                <div className="flex justify-end">
                  <Button onClick={() => setSetupStep(1)}>
                    Next: Get Bot Token{" "}
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 1: Bot Token ── */}
            {setupStep === 1 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Bot className="w-5 h-5 text-primary" />
                    Copy Your Bot Token
                  </h3>
                  <p className="text-muted-foreground">
                    On the Bot page in the Developer Portal, click{" "}
                    <strong>"Reset Token"</strong> (or "Copy" if visible), then
                    paste it below.
                  </p>
                </div>

                <Alert className="border-warning/40 bg-warning/10 text-sm">
                  <AlertTriangle className="h-4 w-4 text-warning" />
                  <AlertTitle className="text-warning">Important</AlertTitle>
                  <AlertDescription>
                    Discord only shows the token once after you reset it. If you
                    lose it, you will need to generate a new one. Treat it like
                    a password and never share it publicly.
                  </AlertDescription>
                </Alert>

                <div className="space-y-3">
                  <Label htmlFor="setup-token" className="text-sm font-medium">
                    Bot Token
                  </Label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        id="setup-token"
                        type={showToken ? "text" : "password"}
                        value={token}
                        onChange={(e) => {
                          setToken(e.target.value);
                          setBotInfo(null);
                          setInviteUrl(null);
                        }}
                        placeholder="Paste your bot token here..."
                        className="pr-10 font-mono text-sm"
                        maxLength={200}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full"
                        onClick={() => setShowToken(!showToken)}
                        aria-label={showToken ? "Hide token" : "Show token"}
                      >
                        {showToken ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                    <Button
                      onClick={handleTestToken}
                      disabled={testing || !token}
                      className="min-w-[100px]"
                    >
                      {testing ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <>
                          <Zap className="w-4 h-4 mr-1.5" /> Verify
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Token test result */}
                {botInfo && (
                  <Alert className="border-primary/30 bg-primary/10">
                    {botInfo.avatar && (
                      <img
                        src={botInfo.avatar}
                        alt={`${botInfo.username} avatar`}
                        className="w-12 h-12 rounded-full"
                        width={48}
                        height={48}
                        loading="lazy"
                      />
                    )}
                    <div>
                      <p className="flex items-center gap-2 font-semibold text-primary">
                        <CheckCircle2 className="w-4 h-4" /> Token verified!
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Bot:{" "}
                        <span className="font-mono font-medium">
                          {botInfo.username}
                        </span>{" "}
                        (ID: <span className="font-mono">{botInfo.id}</span>)
                      </p>
                    </div>
                  </Alert>
                )}

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(0)}>
                    <ChevronLeft className="w-4 h-4 mr-1" /> Back
                  </Button>
                  <Button onClick={() => setSetupStep(2)} disabled={!botInfo}>
                    Next: Enable Intents{" "}
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 2: Enable Intents ── */}
            {setupStep === 2 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <ToggleLeft className="w-5 h-5 text-primary" />
                    Enable Privileged Intents
                  </h3>
                  <p className="text-muted-foreground">
                    Still on the <strong>Bot</strong> page in the Developer
                    Portal, scroll down to{" "}
                    <strong>"Privileged Gateway Intents"</strong> and enable
                    these:
                  </p>
                </div>

                <div className="space-y-3">
                  {[
                    {
                      name: "Server Members Intent",
                      why: "Required to check user roles for admin commands",
                      required: true,
                    },
                    {
                      name: "Message Content Intent",
                      why: "Required for two-way chat bridge (Discord ↔ Game)",
                      required: true,
                    },
                  ].map((intent) => (
                    <div
                      key={intent.name}
                      className="flex items-start gap-3 p-4 rounded-lg border bg-muted/30"
                    >
                      <div className="relative mt-0.5 h-5 w-10 shrink-0 rounded-full border border-primary/15 bg-primary/10">
                        <div className="absolute right-0.5 top-0.5 h-4 w-4 rounded-full bg-card shadow-sm" />
                      </div>
                      <div>
                        <p className="font-medium flex items-center gap-2">
                          {intent.name}
                          {intent.required && (
                            <Badge variant="secondary" className="text-xs">
                              Required
                            </Badge>
                          )}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {intent.why}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                <Alert className="border-border/60 bg-muted/40 text-sm">
                  <Bell className="h-4 w-4 text-primary" />
                  <AlertTitle>Do not forget to save</AlertTitle>
                  <AlertDescription>
                    After toggling the intents on, scroll down and click the
                    Save Changes button on the Discord page.
                  </AlertDescription>
                </Alert>

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(1)}>
                    <ChevronLeft className="w-4 h-4 mr-1" /> Back
                  </Button>
                  <Button onClick={() => setSetupStep(3)}>
                    Next: Invite Bot <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 3: Invite Bot ── */}
            {setupStep === 3 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <UserPlus className="w-5 h-5 text-primary" />
                    Invite the Bot to Your Discord Server
                  </h3>
                  <p className="text-muted-foreground">
                    {inviteUrl
                      ? 'Click the button below to invite your bot. Select your Discord server from the dropdown, then click "Authorize".'
                      : "We need your bot token to generate an invite link. Go back to Step 2 and paste + verify your token first, or use the manual method below."}
                  </p>
                </div>

                {inviteUrl ? (
                  <div className="space-y-4">
                    {/* One-click invite */}
                    <div className="p-5 rounded-lg border-2 border-primary/30 bg-primary/5 text-center space-y-3">
                      <p className="font-medium">Your invite link is ready!</p>
                      <Button size="lg" asChild>
                        <a
                          href={inviteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <UserPlus className="w-5 h-5 mr-2" /> Invite Bot to
                          Server{" "}
                          <span className="sr-only">(opens in new tab)</span>
                        </a>
                      </Button>
                      <div className="flex w-full flex-col items-center justify-center gap-2 sm:flex-row">
                        <p className="max-w-md break-all text-left font-mono text-xs text-muted-foreground sm:text-center">
                          {inviteUrl}
                        </p>
                        <CopyButton text={inviteUrl} label="Copy URL" />
                      </div>
                    </div>

                    <div className="text-sm text-muted-foreground space-y-1">
                      <p>
                        <strong>Permissions included:</strong> Send Messages,
                        Embed Links, Read Message History, Use Slash Commands
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <Alert className="border-warning/40 bg-warning/10 text-sm">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                      <AlertTitle className="text-warning">
                        Manual invite
                      </AlertTitle>
                      <AlertDescription className="space-y-3">
                        <p>
                          If you have not verified your token yet, you can still
                          invite the bot manually.
                        </p>
                        <ol className="text-muted-foreground space-y-2 list-decimal list-inside">
                          <li>
                            In the Developer Portal, go to your app →{" "}
                            <strong>OAuth2</strong> →{" "}
                            <strong>URL Generator</strong>
                          </li>
                          <li>
                            Under "Scopes", check <strong>bot</strong> and{" "}
                            <strong>applications.commands</strong>
                          </li>
                          <li>
                            Under "Bot Permissions", check{" "}
                            <strong>Send Messages</strong>,{" "}
                            <strong>Embed Links</strong>,{" "}
                            <strong>Read Message History</strong>,{" "}
                            <strong>Use Slash Commands</strong>
                          </li>
                          <li>
                            Copy the generated URL at the bottom and open it in
                            your browser
                          </li>
                          <li>
                            Select your Discord server and click{" "}
                            <strong>Authorize</strong>
                          </li>
                        </ol>
                      </AlertDescription>
                    </Alert>
                    <p className="text-sm text-muted-foreground">
                      Tip: go back to Step 2 and verify your token — we'll
                      generate the invite link automatically.
                    </p>
                  </div>
                )}

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(2)}>
                    <ChevronLeft className="w-4 h-4 mr-1" /> Back
                  </Button>
                  <Button onClick={() => setSetupStep(4)}>
                    Next: Server IDs <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 4: Get Server IDs ── */}
            {setupStep === 4 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Hash className="w-5 h-5 text-primary" />
                    Configure Server IDs
                  </h3>
                  <p className="text-muted-foreground">
                    The bot needs your Discord server's ID to register slash
                    commands. You can also set a notification channel and an
                    admin role.
                  </p>
                </div>

                {/* Developer Mode instructions */}
                <Alert className="border-border/60 bg-muted/40 text-sm">
                  <Settings className="h-4 w-4 text-primary" />
                  <AlertTitle>How to enable Developer Mode</AlertTitle>
                  <AlertDescription>
                    <ol className="text-muted-foreground space-y-1 list-decimal list-inside">
                      <li>
                        Open Discord → <strong>User Settings</strong> (gear
                        icon, bottom-left)
                      </li>
                      <li>
                        Go to <strong>App Settings → Advanced</strong>
                      </li>
                      <li>
                        Toggle on <strong>Developer Mode</strong>
                      </li>
                    </ol>
                    <p className="text-muted-foreground mt-2">
                      Now you can right-click servers, channels, and roles to
                      see a <strong>"Copy ID"</strong> option.
                    </p>
                  </AlertDescription>
                </Alert>

                <div className="space-y-5">
                  {/* Guild ID */}
                  <div className="space-y-2">
                    <Label
                      htmlFor="setup-guildId"
                      className="flex items-center gap-2 font-medium"
                    >
                      <Server className="w-4 h-4 text-primary" />
                      Guild (Server) ID
                      <Badge variant="secondary" className="text-xs">
                        Required
                      </Badge>
                    </Label>
                    <Input
                      id="setup-guildId"
                      value={guildId}
                      onChange={(e) => setGuildId(e.target.value)}
                      placeholder="123456789012345678"
                      className="font-mono"
                      maxLength={20}
                    />
                    <p className="text-xs text-muted-foreground">
                      Right-click your Discord server name →{" "}
                      <strong>Copy Server ID</strong>
                    </p>
                    {hasGuildIdError && (
                      <p className="text-xs text-destructive">
                        Invalid format — should be a 17-19 digit number
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Channel ID */}
                    <div className="space-y-2">
                      <Label
                        htmlFor="setup-channelId"
                        className="flex items-center gap-2 font-medium"
                      >
                        <Hash className="w-4 h-4 text-primary" />
                        Notification / Chat Channel ID
                        <Badge variant="outline" className="text-xs">
                          Recommended
                        </Badge>
                      </Label>
                      <Input
                        id="setup-channelId"
                        value={channelId}
                        onChange={(e) => setChannelId(e.target.value)}
                        placeholder="123456789012345678"
                        className="font-mono"
                        maxLength={20}
                      />
                      <p className="text-xs text-muted-foreground">
                        Right-click a text channel →{" "}
                        <strong>Copy Channel ID</strong>. Used for notifications
                        and two-way chat bridge.
                      </p>
                      {hasChannelIdError && (
                        <p className="text-xs text-destructive">
                          Invalid format — should be a 17-19 digit number
                        </p>
                      )}
                    </div>

                    {/* Admin Role ID */}
                    <div className="space-y-2">
                      <Label
                        htmlFor="setup-adminRole"
                        className="flex items-center gap-2 font-medium"
                      >
                        <Shield className="w-4 h-4 text-primary" />
                        Admin Role ID
                        <Badge variant="outline" className="text-xs">
                          Optional
                        </Badge>
                      </Label>
                      <Input
                        id="setup-adminRole"
                        value={adminRoleId}
                        onChange={(e) => setAdminRoleId(e.target.value)}
                        placeholder="123456789012345678"
                        className="font-mono"
                        maxLength={20}
                      />
                      <p className="text-xs text-muted-foreground">
                        Right-click a role → <strong>Copy Role ID</strong>. Only
                        users with this role can use bot commands. Leave blank
                        to allow everyone.
                      </p>
                      {hasAdminRoleIdError && (
                        <p className="text-xs text-destructive">
                          Invalid format — should be a 17-19 digit number
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(3)}>
                    <ChevronLeft className="w-4 h-4 mr-1" /> Back
                  </Button>
                  <Button
                    onClick={() => setSetupStep(5)}
                    disabled={
                      !guildId ||
                      hasGuildIdError ||
                      hasChannelIdError ||
                      hasAdminRoleIdError
                    }
                  >
                    Next: Launch <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}

            {/* ── Step 5: Launch ── */}
            {setupStep === 5 && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Play className="w-5 h-5 text-primary" />
                    Ready to Launch!
                  </h3>
                  <p className="text-muted-foreground">
                    Review your configuration below, then save and start the
                    bot.
                  </p>
                </div>

                {/* Review */}
                <div className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">Bot Token</p>
                      <p className="break-all font-mono text-sm">
                        {token
                          ? "••••••••" + token.slice(-4)
                          : "(not set — will fail)"}
                      </p>
                    </div>
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">Guild ID</p>
                      <p className="break-all font-mono text-sm">
                        {guildId || "(not set — required)"}
                      </p>
                    </div>
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">
                        Channel ID
                      </p>
                      <p className="break-all font-mono text-sm">
                        {channelId || "(none)"}
                      </p>
                    </div>
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">
                        Admin Role ID
                      </p>
                      <p className="break-all font-mono text-sm">
                        {adminRoleId || "(none — all users can use commands)"}
                      </p>
                    </div>
                  </div>
                  {botInfo && (
                    <Alert className="border-primary/30 bg-primary/10 py-3">
                      {botInfo.avatar && (
                        <img
                          src={botInfo.avatar}
                          alt={`${botInfo.username} avatar`}
                          className="w-8 h-8 rounded-full"
                          width={32}
                          height={32}
                          loading="lazy"
                        />
                      )}
                      <p className="text-sm">
                        <span className="font-medium text-primary">
                          Token verified
                        </span>{" "}
                        — {botInfo.username}
                      </p>
                    </Alert>
                  )}
                </div>

                {/* Auto-Start */}
                <div className="flex items-center justify-between p-4 rounded-lg border">
                  <div>
                    <Label className="font-medium">Auto-start bot</Label>
                    <p className="text-sm text-muted-foreground">
                      Automatically start the Discord bot when the panel
                      launches
                    </p>
                  </div>
                  <Switch checked={autoStart} onCheckedChange={setAutoStart} />
                </div>

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setSetupStep(4)}>
                    <ChevronLeft className="w-4 h-4 mr-1" /> Back
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => handleSaveConfig(false)}
                      disabled={saving || !canSaveConfig}
                    >
                      {saving ? (
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Settings className="w-4 h-4 mr-2" />
                      )}
                      Save Draft
                    </Button>
                    <Button
                      onClick={() => handleSaveConfig(true)}
                      disabled={saving || !canSaveConfig}
                    >
                      {saving ? (
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Play className="w-4 h-4 mr-2" />
                      )}
                      Save & Start Bot
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* What you get */}
        <Card>
          <CardHeader>
            <CardTitle>What does the bot do?</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border/60 text-sm">
              <div className="flex gap-3 py-3 first:pt-0">
                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="space-y-1">
                  <p className="font-medium">Slash Commands</p>
                  <p className="text-muted-foreground">
                    Control your PZ server from Discord with /status, /players,
                    /start, /stop, /restart, /broadcast, /kick, and /rcon.
                  </p>
                </div>
              </div>
              <div className="flex gap-3 py-3">
                <MessagesSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="space-y-1">
                  <p className="font-medium">Two-Way Chat Bridge</p>
                  <p className="text-muted-foreground">
                    Keep Discord and in-game chat in the same loop without
                    switching tools during live admin work.
                  </p>
                </div>
              </div>
              <div className="flex gap-3 py-3 last:pb-0">
                <Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="space-y-1">
                  <p className="font-medium">Event Notifications</p>
                  <p className="text-muted-foreground">
                    Send join/leave, start/stop, restart, death, and backup
                    events straight to the channel your admins already watch.
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ═════════════════════════════════════════════════
  // MANAGEMENT VIEW — shown when bot is configured
  // ═════════════════════════════════════════════════
  return (
    <div className="space-y-6 page-transition">
      {/* Header */}
      <PageHeader
        title="Discord Bot"
        description="Manage your Discord bot, slash commands, and event notifications"
        icon={<MessageSquare className="w-5 h-5" />}
        actions={
          <div className="flex items-center gap-2">
            <div
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide ${
                status?.running
                  ? "border-primary/40 bg-primary/[0.08] text-primary"
                  : "border-border/55 bg-muted/40 text-muted-foreground"
              }`}
            >
              {status?.running ? (
                <span
                  className="relative inline-flex w-2 h-2"
                  aria-hidden="true"
                >
                  <span className="absolute inset-0 rounded-full bg-primary/40 animate-ping motion-reduce:hidden" />
                  <span className="relative w-2 h-2 rounded-full bg-primary" />
                </span>
              ) : (
                <span
                  className="w-2 h-2 rounded-full border border-muted-foreground/50"
                  aria-hidden="true"
                />
              )}
              {status?.running ? "Running" : "Stopped"}
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={loadData}
              aria-label="Refresh status"
              className="h-10 w-10"
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        }
      />

      {/* Status Message */}
      <InlineFeedback message={configMessage} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bot Status */}
        <Card className="relative overflow-hidden">
          <div
            className={`absolute top-0 left-0 right-0 h-[2px] ${
              status?.running
                ? "bg-gradient-to-r from-primary via-primary/80 to-primary/30"
                : status?.error
                  ? "bg-gradient-to-r from-destructive via-destructive/80 to-destructive/30"
                  : "bg-gradient-to-r from-muted-foreground/40 via-muted-foreground/20 to-transparent"
            }`}
            aria-hidden="true"
          />
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="w-5 h-5" />
              Bot Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div
                className={`rounded-lg border px-4 py-3 ${status?.running ? "border-primary/30 bg-primary/5" : "border-border/60 bg-muted/40"}`}
              >
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Runtime
                </p>
                <p
                  className={`mt-1 flex items-center gap-2 text-lg font-semibold ${status?.running ? "text-primary" : ""}`}
                >
                  {status?.running && (
                    <span
                      className="relative inline-flex w-2 h-2"
                      aria-hidden="true"
                    >
                      <span className="absolute inset-0 rounded-full bg-primary/40 animate-ping motion-reduce:hidden" />
                      <span className="relative w-2 h-2 rounded-full bg-primary" />
                    </span>
                  )}
                  {status?.running ? "Online" : "Offline"}
                </p>
              </div>
              <div className="min-w-0 rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Bot User
                </p>
                <p className="mt-1 truncate text-lg font-semibold">
                  {status?.username || "Waiting for login"}
                </p>
              </div>
              <div
                className={`min-w-0 rounded-lg border px-4 py-3 ${config?.channelId ? "border-border/60 bg-muted/30" : "border-warning/30 bg-warning/[0.06]"}`}
              >
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Channel
                </p>
                <p
                  className={`mt-1 truncate text-lg font-semibold ${config?.channelId ? "" : "text-warning"}`}
                >
                  {config?.channelId ? "Linked" : "Not set"}
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Notifications, slash commands, and the chat bridge all depend on
              the bot staying connected to the configured channel.
            </p>

            {status?.error && (
              <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                <p className="text-sm text-destructive font-medium">
                  Bot Error
                </p>
                <p className="text-sm text-destructive/80">{status.error}</p>
              </div>
            )}

            <div className="flex gap-2">
              {status?.running ? (
                <Button
                  variant="destructive"
                  onClick={handleStop}
                  className="flex-1"
                  disabled={stopping}
                >
                  {stopping ? (
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Square className="w-4 h-4 mr-2" />
                  )}
                  {stopping ? "Stopping..." : "Stop Bot"}
                </Button>
              ) : (
                <Button
                  onClick={handleStart}
                  className="flex-1"
                  disabled={starting}
                >
                  {starting ? (
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 mr-2" />
                  )}
                  {starting ? "Starting..." : "Start Bot"}
                </Button>
              )}

              {status?.running && config?.channelId && (
                <Button
                  variant="outline"
                  onClick={handleSendTestMessage}
                  disabled={sendingTest}
                >
                  {sendingTest ? (
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 mr-2" />
                  )}
                  {sendingTest ? "Sending..." : "Send Test"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Command Permissions */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Command Permissions
            </CardTitle>
            <CardDescription>
              Control who can use each slash command. Assign a permission tier
              per command.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Tier legend */}
            <div className="flex flex-wrap gap-3 text-sm mb-2">
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" />
                <span className="font-medium">Everyone</span>
                <span className="text-muted-foreground">— any user</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground" />
                <span className="font-medium">Moderator</span>
                <span className="text-muted-foreground">
                  — Mod or Admin role
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-destructive" />
                <span className="font-medium">Admin</span>
                <span className="text-muted-foreground">— Admin role only</span>
              </div>
            </div>

            <div className="space-y-1.5">
              {[
                { cmd: "status", label: "/status", desc: "View server status" },
                {
                  cmd: "players",
                  label: "/players",
                  desc: "List online players",
                },
                { cmd: "save", label: "/save", desc: "Save the world" },
                {
                  cmd: "broadcast",
                  label: "/broadcast",
                  desc: "Send server message",
                },
                { cmd: "kick", label: "/kick", desc: "Kick a player" },
                { cmd: "start", label: "/start", desc: "Start the server" },
                { cmd: "stop", label: "/stop", desc: "Stop the server" },
                {
                  cmd: "restart",
                  label: "/restart",
                  desc: "Restart with warning",
                },
                { cmd: "rcon", label: "/rcon", desc: "Execute RCON command" },
              ].map((c) => {
                const level = commandPermissions[c.cmd] || "admin";
                return (
                  <div
                    key={c.cmd}
                    className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 p-2.5"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <code className="text-sm font-semibold shrink-0">
                        {c.label}
                      </code>
                      <span className="text-sm text-muted-foreground truncate hidden sm:inline">
                        {c.desc}
                      </span>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {(["everyone", "moderator", "admin"] as const).map(
                        (tier) => {
                          const isActive = level === tier;
                          const variant = isActive
                            ? tier === "everyone"
                              ? "default"
                              : tier === "moderator"
                                ? "secondary"
                                : "destructive"
                            : "ghost";
                          const icons = {
                            everyone: <Users className="w-3 h-3" />,
                            moderator: <Shield className="w-3 h-3" />,
                            admin: <Lock className="w-3 h-3" />,
                          };
                          return (
                            <Button
                              key={tier}
                              variant={variant}
                              size="sm"
                              className="h-7 gap-1 px-2 text-xs"
                              onClick={() =>
                                setCommandPermissions((prev) => ({
                                  ...prev,
                                  [c.cmd]: tier,
                                }))
                              }
                            >
                              {icons[tier]}
                              <span className="hidden sm:inline capitalize">
                                {tier}
                              </span>
                            </Button>
                          );
                        },
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={async () => {
                  try {
                    setSavingPermissions(true);
                    await discordApi.updatePermissions(commandPermissions);
                    setPermissionsMessage({
                      type: "success",
                      text: "Command permissions saved. Slash commands re-registered.",
                    });
                  } catch (error: unknown) {
                    const msg =
                      error instanceof Error
                        ? error.message
                        : "Failed to save permissions";
                    setPermissionsMessage({ type: "error", text: msg });
                  } finally {
                    setSavingPermissions(false);
                  }
                }}
                disabled={savingPermissions}
              >
                {savingPermissions ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />{" "}
                    Saving...
                  </>
                ) : (
                  "Save Permissions"
                )}
              </Button>
            </div>
            <InlineFeedback message={permissionsMessage} className="mt-3" />
          </CardContent>
        </Card>
      </div>

      {/* Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            Bot Configuration
          </CardTitle>
          <CardDescription>Update bot credentials and settings</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Bot Token */}
          <div className="space-y-2">
            <Label htmlFor="token" className="flex items-center gap-2">
              <Bot className="w-4 h-4" />
              Bot Token
              {config?.hasToken && (
                <Badge variant="outline" className="text-xs">
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Configured
                </Badge>
              )}
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="token"
                  type={showToken ? "text" : "password"}
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    setBotInfo(null);
                    setInviteUrl(null);
                  }}
                  placeholder={
                    config?.hasToken
                      ? "••••••••••••••••  (leave blank to keep current)"
                      : "Enter bot token"
                  }
                  className="pr-10"
                  maxLength={200}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setShowToken(!showToken)}
                  aria-label={showToken ? "Hide token" : "Show token"}
                >
                  {showToken ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </Button>
              </div>
              <Button
                variant="outline"
                onClick={handleTestToken}
                disabled={testing || !token}
              >
                {testing ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Zap className="w-4 h-4 mr-1.5" /> Verify Token
                  </>
                )}
              </Button>
            </div>
            {botInfo && (
              <div className="flex items-center gap-2 text-sm text-primary">
                {botInfo.avatar && (
                  <img
                    src={botInfo.avatar}
                    alt={`${botInfo.username} avatar`}
                    className="w-5 h-5 rounded-full"
                    width={20}
                    height={20}
                    loading="lazy"
                  />
                )}
                <CheckCircle2 className="w-3.5 h-3.5" /> Valid token —{" "}
                {botInfo.username}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Guild ID */}
            <div className="space-y-2">
              <Label htmlFor="guildId" className="flex items-center gap-2">
                <Server className="w-4 h-4" />
                Guild (Server) ID *
              </Label>
              <Input
                id="guildId"
                value={guildId}
                onChange={(e) => setGuildId(e.target.value)}
                placeholder="123456789012345678"
                className="font-mono"
                maxLength={20}
              />
              <p className="text-xs text-muted-foreground">
                Right-click server → Copy Server ID
              </p>
              {hasGuildIdError && (
                <p className="text-xs text-destructive">
                  Invalid format — use a 17-19 digit server ID
                </p>
              )}
            </div>

            {/* Channel ID */}
            <div className="space-y-2">
              <Label htmlFor="channelId" className="flex items-center gap-2">
                <Hash className="w-4 h-4" />
                Notification / Chat Channel
              </Label>
              <Input
                id="channelId"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                placeholder="Optional"
                className="font-mono"
                maxLength={20}
              />
              <p className="text-xs text-muted-foreground">
                For notifications & chat bridge
              </p>
              {hasChannelIdError && (
                <p className="text-xs text-destructive">
                  Invalid format — use a 17-19 digit channel ID
                </p>
              )}
            </div>

            {/* Admin Role ID */}
            <div className="space-y-2">
              <Label htmlFor="adminRoleId" className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-primary" />
                Admin Role ID
              </Label>
              <Input
                id="adminRoleId"
                value={adminRoleId}
                onChange={(e) => setAdminRoleId(e.target.value)}
                placeholder="Optional"
                className="font-mono"
                maxLength={20}
              />
              <p className="text-xs text-muted-foreground">
                Full access for role-protected commands. Server owners and Discord Administrators always retain access.
              </p>
              {hasAdminRoleIdError && (
                <p className="text-xs text-destructive">
                  Invalid format — use a 17-19 digit role ID
                </p>
              )}
            </div>

            {/* Moderator Role ID */}
            <div className="space-y-2">
              <Label htmlFor="modRoleId" className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                Moderator Role ID
              </Label>
              <Input
                id="modRoleId"
                value={modRoleId}
                onChange={(e) => setModRoleId(e.target.value)}
                placeholder="Optional"
                className="font-mono"
                maxLength={20}
              />
              <p className="text-xs text-muted-foreground">
                Can use "moderator" tier commands. Without a configured role, role-protected commands remain locked.
              </p>
              {hasModRoleIdError && (
                <p className="text-xs text-destructive">
                  Invalid format — use a 17-19 digit role ID
                </p>
              )}
            </div>
          </div>

          {/* Auto-Start */}
          <div className="flex items-center justify-between p-4 rounded-lg border">
            <div>
              <Label className="font-medium">Auto-start on panel launch</Label>
              <p className="text-sm text-muted-foreground">
                The bot will start automatically when the panel boots up
              </p>
            </div>
            <Switch checked={autoStart} onCheckedChange={setAutoStart} />
          </div>

          {/* Chat Relay */}
          <div className="space-y-4 p-4 rounded-lg border">
            <div className="flex items-center justify-between">
              <div>
                <Label className="font-medium">Chat Relay</Label>
                <p className="text-sm text-muted-foreground">
                  Bridge chat both ways between the game server and Discord
                </p>
              </div>
              <Switch
                checked={chatRelayEnabled}
                onCheckedChange={setChatRelayEnabled}
              />
            </div>
            {chatRelayEnabled && (
              <div className="space-y-2">
                <Label htmlFor="chatRelayScope" className="text-sm">
                  Which messages to forward
                </Label>
                <Select
                  value={chatRelayScope}
                  onValueChange={(v) =>
                    setChatRelayScope(v as "public" | "general")
                  }
                >
                  <SelectTrigger id="chatRelayScope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">
                      All public chat (Say, Shout, General)
                    </SelectItem>
                    <SelectItem value="general">General tab only</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Faction, safehouse, radio and admin chat are never forwarded.
                  Build 42 records ordinary talking as Say, so "General tab
                  only" relays very little.
                </p>
              </div>
            )}
            {chatRelayEnabled && (
              <div className="space-y-2">
                <Label htmlFor="chatRelayChannelId" className="text-sm">
                  Chat Relay Channel (optional)
                </Label>
                <Input
                  id="chatRelayChannelId"
                  value={chatRelayChannelId}
                  onChange={(e) => setChatRelayChannelId(e.target.value)}
                  placeholder="Leave empty to use main channel"
                  className="font-mono"
                  maxLength={20}
                />
                <p className="text-xs text-muted-foreground">
                  Relay game chat and Discord messages through a separate channel.
                  Leave empty to use the main channel above.
                </p>
                {hasChatRelayChannelIdError && (
                  <p className="text-xs text-destructive">
                    Invalid format — use a 17-19 digit channel ID
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="rounded-lg border border-destructive/25 bg-destructive/[0.05] px-4 py-3 text-sm text-muted-foreground">
              Moving the bot to a new Discord server? Use wipe to remove the
              stored Discord setup and restart the wizard cleanly.
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="destructive"
                onClick={handleResetConfig}
                disabled={resetting}
              >
                {resetting ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />{" "}
                    Wiping...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4 mr-2" /> Wipe Discord Setup
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={loadData}>
                Cancel
              </Button>
              <Button
                onClick={() => handleSaveConfig(false)}
                disabled={saving || !canSaveConfig}
              >
                {saving ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />{" "}
                    Saving...
                  </>
                ) : (
                  "Save Changes"
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Webhook Events */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="w-5 h-5" />
            Event Notifications
          </CardTitle>
          <CardDescription>
            Automatic notifications posted to your Discord channel when server
            events occur
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {Object.entries(eventLabels).map(
            ([eventKey, { label, description, variables }]) => {
              const event = webhookEvents[eventKey] || {
                enabled: false,
                template: "",
              };
              return (
                <div key={eventKey} className="space-y-3 p-4 border rounded-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-base font-medium">{label}</Label>
                      <p className="text-sm text-muted-foreground">
                        {description}
                      </p>
                    </div>
                    <Switch
                      checked={event.enabled}
                      onCheckedChange={(checked) =>
                        handleToggleEvent(eventKey, checked)
                      }
                    />
                  </div>
                  {event.enabled && (
                    <div className="space-y-2">
                      <Label
                        htmlFor={`template-${eventKey}`}
                        className="text-sm"
                      >
                        Message Template
                      </Label>
                      <Textarea
                        id={`template-${eventKey}`}
                        value={event.template}
                        onChange={(e) =>
                          handleUpdateTemplate(eventKey, e.target.value)
                        }
                        placeholder="Enter notification message..."
                        rows={3}
                      />
                      <p className="text-xs text-muted-foreground">
                        Available variables: {variables}
                      </p>
                    </div>
                  )}
                </div>
              );
            },
          )}
          <div className="flex justify-end">
            <Button onClick={handleSaveWebhookEvents} disabled={savingEvents}>
              {savingEvents ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Saving...
                </>
              ) : (
                "Save Events"
              )}
            </Button>
          </div>
          <InlineFeedback message={eventsMessage} className="mt-3" />
        </CardContent>
      </Card>
    </div>
  );
}
