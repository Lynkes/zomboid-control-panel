import { useState, useEffect, useContext, useRef, useMemo } from "react";
import {
  Download,
  Server,
  CheckCircle,
  Loader2,
  Terminal,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  Eye,
  EyeOff,
  Cpu,
  FolderOpen,
  Zap,
  Shield,
  Settings2,
  Plus,
  HardDrive,
  Play,
  Sparkles,
  RefreshCw,
  Copy,
  Check,
  Info,
  ArrowRight,
} from "lucide-react";
import { configApi, serverApi, serversApi, debugApi } from "@/lib/api";
import { useNavigate } from "react-router-dom";
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
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/components/ui/use-toast";
import { SocketContext } from "@/contexts/SocketContext";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { reportClientError } from "@/lib/client-errors";
import { cn, copyText } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { FolderBrowser } from "@/components/FolderBrowser";

interface InstallLog {
  type: "info" | "success" | "error" | "command" | "stdout" | "stderr";
  message: string;
  timestamp: Date;
}

type SetupMode = "select" | "full" | "quick";

function handleCardKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  onActivate: () => void,
) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onActivate();
  }
}

// Generate a random password
function generatePassword(length = 12): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Format bytes to human readable size
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

const LINUX_SERVICE_INSTALL_PATH = "/opt/zomboid-panel/data/pzserver";

function installationErrorGuidance(message: string) {
  if (!message.startsWith("Installation path is not writable:")) {
    return message;
  }

  return `${message} On Linux, use ${LINUX_SERVICE_INSTALL_PATH}, or add both your install folder and its _Data folder to ReadWritePaths in zomboid-panel.service, then restart the service.`;
}

export default function ServerSetup() {
  const [setupMode, setSetupMode] = useState<SetupMode>("select");
  const [currentStep, setCurrentStep] = useState(1);

  // Step 1: Prerequisites
  const [steamCmdPath, setSteamCmdPath] = useState("");
  const [hasSteamCmd, setHasSteamCmd] = useState(false);

  // Step 2: Server Config
  const [installPath, setInstallPath] = useState("");
  const [serverName, setServerName] = useState("myserver");
  const [branch, setBranch] = useState("public");
  const [availableBranches, setAvailableBranches] = useState<
    Array<{ name: string; description: string; buildId?: string | null }>
  >([
    { name: "public", description: "Stable release (Build 42)" },
    { name: "b41multiplayer", description: "Build 41 Multiplayer" },
  ]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [useCustomDataPath, setUseCustomDataPath] = useState(false);
  const [zomboidDataPath, setZomboidDataPath] = useState("");
  const [rconPassword, setRconPassword] = useState("");
  const [rconPort, setRconPort] = useState(27015);
  const [showRconPassword, setShowRconPassword] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);

  // Step 3: Performance
  const [minMemory, setMinMemory] = useState(4);
  const [maxMemory, setMaxMemory] = useState(8);
  const [serverPort, setServerPort] = useState(16261);
  const [useUpnp, setUseUpnp] = useState(true);
  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const missingAdminPassword = adminPassword.trim().length === 0;
  const [useNoSteam, setUseNoSteam] = useState(false);
  const [useDebug, setUseDebug] = useState(false);
  const [systemRam, setSystemRam] = useState<{
    totalGB: number;
    freeGB: number;
    recommendedMin: number;
    recommendedMax: number;
  } | null>(null);
  const [detectingRam, setDetectingRam] = useState(false);

  // Installation state
  const [installing, setInstalling] = useState(false);
  const [logs, setLogs] = useState<InstallLog[]>([]);
  const [installComplete, setInstallComplete] = useState(false);
  const [installProgress, setInstallProgress] = useState<{
    percent: number;
    downloaded: string;
    total: string;
    status: string;
  } | null>(null);

  // SteamCMD auto-download state
  const [downloadingSteamCmd, setDownloadingSteamCmd] = useState(false);
  const [steamCmdStatus, setSteamCmdStatus] = useState<string>("");

  const { toast } = useToast();
  const socket = useContext(SocketContext);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const navigateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [startingServer, setStartingServer] = useState(false);

  // Refs for socket handler closure — avoids re-registering socket listeners when form state changes
  const formStateRef = useRef({
    serverName,
    installPath,
    zomboidDataPath,
    useCustomDataPath,
    rconPort,
    rconPassword,
    adminPassword,
    serverPort,
    minMemory,
    maxMemory,
    useNoSteam,
    useDebug,
  });
  useEffect(() => {
    formStateRef.current = {
      serverName,
      installPath,
      zomboidDataPath,
      useCustomDataPath,
      rconPort,
      rconPassword,
      adminPassword,
      serverPort,
      minMemory,
      maxMemory,
      useNoSteam,
      useDebug,
    };
  }, [
    serverName,
    installPath,
    zomboidDataPath,
    useCustomDataPath,
    rconPort,
    rconPassword,
    adminPassword,
    serverPort,
    minMemory,
    maxMemory,
    useNoSteam,
    useDebug,
  ]);

  // Clean up navigate timer on unmount
  useEffect(
    () => () => {
      if (navigateTimerRef.current) clearTimeout(navigateTimerRef.current);
    },
    [],
  );

  // Total steps based on mode
  const totalSteps = setupMode === "quick" ? 3 : 4;

  // Validation for each step
  const stepValidation = useMemo(() => {
    if (setupMode === "quick") {
      return {
        1: installPath.length > 0,
        2: serverName.length > 0 && rconPassword.length >= 6,
        3: true,
      };
    }
    return {
      1: steamCmdPath.length > 0 && hasSteamCmd,
      2: installPath.length > 0 && serverName.length > 0,
      3: rconPassword.length >= 6,
      4: true,
    };
  }, [
    setupMode,
    steamCmdPath,
    hasSteamCmd,
    installPath,
    serverName,
    rconPassword,
  ]);

  const canProceed = stepValidation[currentStep as keyof typeof stepValidation];

  // Generate random password on mount if empty
  useEffect(() => {
    if (!rconPassword) {
      setRconPassword(generatePassword(12));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentional mount-only: only generate once if blank

  // Auto-detect RAM on mount
  useEffect(() => {
    handleAutoDetectRam();
  }, []);

  // Load saved settings
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await configApi.getAppSettings();
        const settings = data.settings || {};
        if (settings.steamcmdPath) {
          setSteamCmdPath(settings.steamcmdPath);
          setHasSteamCmd(true);
        }
        if (settings.serverPath) setInstallPath(settings.serverPath);
        if (settings.serverName) setServerName(settings.serverName);
        if (settings.zomboidDataPath) {
          setZomboidDataPath(settings.zomboidDataPath);
          setUseCustomDataPath(true);
        }
        // Memory is stored in MB, convert to GB for display
        // Clamp to reasonable values (2-16 GB) to match slider range
        if (settings.minMemory)
          setMinMemory(
            Math.min(
              16,
              Math.max(2, Math.round(settings.minMemory / 1024) || 4),
            ),
          );
        if (settings.maxMemory)
          setMaxMemory(
            Math.min(
              16,
              Math.max(2, Math.round(settings.maxMemory / 1024) || 8),
            ),
          );
        if (settings.serverPort) setServerPort(settings.serverPort);
      } catch (error) {
        reportClientError("Failed to load settings.", error);
      }
    };
    loadSettings();
  }, []);

  // Fetch available Steam branches
  useEffect(() => {
    const fetchBranches = async () => {
      setLoadingBranches(true);
      try {
        const data = await serverApi.getBranches(steamCmdPath);
        if (data.branches && Array.isArray(data.branches)) {
          setAvailableBranches(data.branches);
          if (!data.branches.find((b: { name: string }) => b.name === branch)) {
            setBranch("public");
          }
        }
      } catch (error) {
        reportClientError("Failed to fetch branches.", error);
      } finally {
        setLoadingBranches(false);
      }
    };

    if (hasSteamCmd && steamCmdPath) {
      fetchBranches();
    }
  }, [hasSteamCmd, steamCmdPath]); // eslint-disable-line react-hooks/exhaustive-deps -- branch intentionally excluded; setBranch('public') inside is a deliberate fallback, not a dep

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Socket.IO events for installation
  useEffect(() => {
    if (!socket) return;

    const handleInstallLog = (data: {
      type: "stdout" | "stderr";
      text: string;
    }) => {
      const text = data.text.trim();
      setLogs((prev) => [
        ...prev,
        { type: data.type, message: text, timestamp: new Date() },
      ]);

      // Parse SteamCMD progress: "Update state (0x61) downloading, progress: 50.00 (1234567890 / 2469135780)"
      const progressMatch = text.match(
        /progress:\s*([\d.]+)\s*\(([\d,]+)\s*\/\s*([\d,]+)\)/,
      );
      if (progressMatch) {
        const percent = parseFloat(progressMatch[1]);
        const downloaded = formatBytes(
          parseInt(progressMatch[2].replace(/,/g, "")),
        );
        const total = formatBytes(parseInt(progressMatch[3].replace(/,/g, "")));
        setInstallProgress({
          percent,
          downloaded,
          total,
          status: "Downloading...",
        });
      }
      // Parse validation: "Validating files... 50%"
      const validateMatch = text.match(/[Vv]alidat\w*[^\d]*(\d+)%/);
      if (validateMatch) {
        setInstallProgress({
          percent: parseInt(validateMatch[1]),
          downloaded: "",
          total: "",
          status: "Validating files...",
        });
      }
      // Parse update state
      if (text.includes("Update state") && text.includes("verifying")) {
        setInstallProgress((prev) =>
          prev ? { ...prev, status: "Verifying installation..." } : null,
        );
      }
      if (text.includes("Success!") || text.includes("fully installed")) {
        setInstallProgress({
          percent: 100,
          downloaded: "",
          total: "",
          status: "Complete!",
        });
      }
    };

    const handleInstallComplete = async (data: {
      success: boolean;
      message: string;
      installPath?: string;
      serverName?: string;
      zomboidDataPath?: string;
      serverConfigPath?: string;
      rconPort?: number;
      rconPassword?: string;
      serverPort?: number;
      minMemory?: number;
      maxMemory?: number;
    }) => {
      setInstalling(false);
      setInstallComplete(data.success);
      if (data.success) {
        setLogs((prev) => [
          ...prev,
          { type: "success", message: data.message, timestamp: new Date() },
        ]);

        try {
          const s = formStateRef.current;
          // Use data from server response which has computed paths
          const createResult = await serversApi.create({
            name: data.serverName || s.serverName,
            serverName: data.serverName || s.serverName,
            installPath: data.installPath || s.installPath,
            zomboidDataPath: data.zomboidDataPath || null,
            serverConfigPath: data.serverConfigPath || null,
            rconHost: "127.0.0.1",
            rconPort: data.rconPort || s.rconPort,
            rconPassword: data.rconPassword || s.rconPassword,
            adminPassword: s.adminPassword,
            serverPort: data.serverPort || s.serverPort,
            minMemory: (data.minMemory || s.minMemory) * 1024,
            maxMemory: (data.maxMemory || s.maxMemory) * 1024,
            useNoSteam: s.useNoSteam,
            useDebug: s.useDebug,
          });
          setLogs((prev) => [
            ...prev,
            {
              type: "success",
              message: "Server registered in panel database",
              timestamp: new Date(),
            },
          ]);

          // Activate the newly created server so "Start Server Now" starts this one
          if (createResult.server?.id) {
            await serversApi.activate(createResult.server.id);
            setLogs((prev) => [
              ...prev,
              {
                type: "success",
                message: "Switched active server to new installation",
                timestamp: new Date(),
              },
            ]);
          }
        } catch (error) {
          reportClientError("Failed to create server entry.", error);
          setLogs((prev) => [
            ...prev,
            {
              type: "error",
              message: "Warning: Failed to register server in panel.",
              timestamp: new Date(),
            },
          ]);
        }

        toast({
          title: "Server Installed",
          description:
            "Project Zomboid server files were installed successfully.",
        });
      } else {
        setLogs((prev) => [
          ...prev,
          { type: "error", message: data.message, timestamp: new Date() },
        ]);
        toast({
          title: "Installation Failed",
          description: data.message,
          variant: "destructive",
        });
      }
    };

    socket.on("install:log", handleInstallLog);
    socket.on("install:complete", handleInstallComplete);

    const handleSteamCmdStatus = (data: {
      status: string;
      message: string;
      path?: string;
    }) => {
      setSteamCmdStatus(data.message);
      if (data.status === "complete" && data.path) {
        setSteamCmdPath(data.path);
        setHasSteamCmd(true);
        setDownloadingSteamCmd(false);
        toast({
          title: "SteamCMD Ready",
          description: "SteamCMD is installed and ready to use.",
        });
      } else if (data.status === "error") {
        setDownloadingSteamCmd(false);
        toast({
          title: "SteamCMD Setup Failed",
          description: data.message,
          variant: "destructive",
        });
      }
    };

    const handleSteamCmdLog = (data: { type: string; text: string }) => {
      setSteamCmdStatus(data.text.trim());
    };

    socket.on("steamcmd:status", handleSteamCmdStatus);
    socket.on("steamcmd:log", handleSteamCmdLog);

    return () => {
      socket.off("install:log", handleInstallLog);
      socket.off("install:complete", handleInstallComplete);
      socket.off("steamcmd:status", handleSteamCmdStatus);
      socket.off("steamcmd:log", handleSteamCmdLog);
    };
  }, [socket, toast]);

  const addLog = (type: InstallLog["type"], message: string) => {
    setLogs((prev) => [...prev, { type, message, timestamp: new Date() }]);
  };

  const handleAutoDownloadSteamCmd = async () => {
    setDownloadingSteamCmd(true);
    setSteamCmdStatus("Starting download...");
    try {
      await serverApi.downloadSteamCmd(steamCmdPath);
    } catch (error) {
      setDownloadingSteamCmd(false);
      toast({
        title: "Download Failed",
        description:
          error instanceof Error
            ? error.message
            : "Failed to start SteamCMD download.",
        variant: "destructive",
      });
    }
  };

  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseSetter, setBrowseSetter] = useState<{
    fn: (path: string) => void;
    title: string;
    initial?: string;
  } | null>(null);

  const handleBrowseFolder = (
    setter: (path: string) => void,
    description: string,
    currentPath?: string,
  ) => {
    setBrowseSetter({ fn: setter, title: description, initial: currentPath });
    setBrowseOpen(true);
  };

  const handleAutoDetectRam = async () => {
    setDetectingRam(true);
    try {
      const data = await debugApi.getRam();
      setSystemRam({
        totalGB: data.totalGB,
        freeGB: data.freeGB,
        recommendedMin: data.recommendedMin,
        recommendedMax: data.recommendedMax,
      });
      setMinMemory(data.recommendedMin);
      setMaxMemory(data.recommendedMax);
    } catch {
      // Silent fail - defaults are fine
    } finally {
      setDetectingRam(false);
    }
  };

  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopyPassword = () => {
    copyText(rconPassword);
    setCopiedPassword(true);
    toast({
      title: "Password Copied",
      description: "RCON password copied to clipboard.",
    });
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopiedPassword(false), 2000);
  };

  useEffect(
    () => () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    },
    [],
  );

  const handleRegeneratePassword = () => {
    setRconPassword(generatePassword(12));
    toast({
      title: "Password Generated",
      description: "A new RCON password has been generated.",
    });
  };

  const handleInstall = async () => {
    if (!adminPassword) {
      toast({
        title: "Admin Password Required",
        description: "Enter an admin password before starting installation.",
        variant: "destructive",
      });
      return;
    }
    setInstalling(true);
    setLogs([]);
    setInstallProgress(null);
    addLog("info", "Starting installation...");

    try {
      await serverApi.install({
        steamcmdPath: steamCmdPath,
        installPath,
        serverName,
        branch,
        zomboidDataPath: useCustomDataPath ? zomboidDataPath : null,
        minMemory,
        maxMemory,
        adminPassword: adminPassword || null,
        serverPort,
        useUpnp,
        useNoSteam,
        useDebug,
        rconPassword,
        rconPort,
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "Unknown error";
      const msg = installationErrorGuidance(rawMessage);
      addLog("error", msg);
      setInstalling(false);
      toast({
        title: "Installation Failed",
        description: msg,
        variant: "destructive",
      });
    }
  };

  const handleQuickSetup = async () => {
    if (!adminPassword) {
      toast({
        title: "Admin Password Required",
        description: "Enter an admin password before creating this server.",
        variant: "destructive",
      });
      return;
    }
    setInstalling(true);
    setLogs([]);
    addLog("info", "Creating server configuration...");

    try {
      const data = await serverApi.quickSetup({
        installPath,
        serverName,
        zomboidDataPath: useCustomDataPath ? zomboidDataPath : null,
        minMemory,
        maxMemory,
        adminPassword: adminPassword || null,
        serverPort,
        useUpnp,
        useNoSteam,
        useDebug,
        rconPassword,
        rconPort,
      });

      if (data) {
        addLog("success", "Server configuration created successfully!");

        try {
          // Use data from server response which has computed paths
          const createResult = await serversApi.create({
            name: data.serverName || serverName,
            serverName: data.serverName || serverName,
            installPath: data.installPath || installPath,
            zomboidDataPath: data.zomboidDataPath || null,
            serverConfigPath: data.serverConfigPath || null,
            rconHost: "127.0.0.1",
            rconPort: data.rconPort || rconPort,
            rconPassword: data.rconPassword || rconPassword,
            adminPassword,
            serverPort: data.serverPort || serverPort,
            minMemory: (data.minMemory || minMemory) * 1024,
            maxMemory: (data.maxMemory || maxMemory) * 1024,
            useNoSteam: useNoSteam,
            useDebug: useDebug,
          });
          addLog("success", "Server registered in panel database");

          // Activate the newly created server so "Start Server Now" starts this one
          if (createResult.server?.id) {
            await serversApi.activate(createResult.server.id);
            addLog("success", "Switched active server to new installation");
          }
        } catch (error) {
          reportClientError("Failed to create server entry.", error);
          addLog("error", "Warning: Failed to register server in panel.");
        }

        setInstallComplete(true);
        toast({
          title: "Server Added",
          description: "Server configuration was created successfully.",
        });
      } else {
        addLog("error", data.error);
        toast({
          title: "Setup Failed",
          description: data.error,
          variant: "destructive",
        });
      }
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : "Unexpected error while creating server.";
      addLog("error", msg);
      toast({
        title: "Setup Failed",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setInstalling(false);
    }
  };

  const handleSaveSteamCmdPath = async () => {
    try {
      await configApi.updateAppSettings({ steamcmdPath: steamCmdPath });
      setHasSteamCmd(true);
      toast({
        title: "Path Saved",
        description: "SteamCMD path saved successfully.",
      });
    } catch {
      toast({
        title: "Save Failed",
        description: "Could not save SteamCMD path.",
        variant: "destructive",
      });
    }
  };

  // Mode selection screen
  if (setupMode === "select") {
    return (
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="text-center space-y-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-primary"
              aria-hidden="true"
            />
            New Server
          </span>
          <h1 className="text-3xl font-bold">Server Setup</h1>
          <p className="text-muted-foreground text-base">
            Choose how you want to bring a Project Zomboid server online.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Full Install Card */}
          {(() => {
            const activate = () => {
              setSetupMode("full");
              setCurrentStep(1);
            };

            return (
              <Card
                role="button"
                tabIndex={0}
                aria-describedby="full-setup-description"
                className="group relative overflow-hidden cursor-pointer border-primary/35 bg-gradient-to-br from-primary/[0.06] via-card to-card ring-1 ring-primary/15 transition-[border-color,box-shadow,transform] hover:border-primary/55 hover:ring-primary/25 hover:shadow-lg hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onClick={activate}
                onKeyDown={(event) => handleCardKeyDown(event, activate)}
              >
                <div
                  className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-primary via-primary/80 to-primary/40"
                  aria-hidden="true"
                />
                <div className="absolute right-3 top-3">
                  <Badge
                    variant="secondary"
                    className="text-[10px] font-medium uppercase tracking-wide"
                  >
                    Recommended
                  </Badge>
                </div>
                <CardHeader className="pb-3">
                  <div className="grid place-items-center w-11 h-11 rounded-md border border-primary/30 bg-primary/[0.08] text-primary mb-3 transition-colors group-hover:bg-primary/15">
                    <Download className="w-5 h-5" />
                  </div>
                  <CardTitle className="text-lg">Fresh Install</CardTitle>
                  <CardDescription
                    id="full-setup-description"
                    className="text-xs"
                  >
                    Download and configure a new dedicated server from scratch
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pb-5">
                  <ul className="space-y-1.5 text-[13px]">
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                      <span>
                        Downloads server files via SteamCMD{" "}
                        <span className="text-foreground/60">(~3 GB)</span>
                      </span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                      <span>Choose game version branch</span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                      <span>
                        Generates config and startup files automatically
                      </span>
                    </li>
                  </ul>
                  <div className="flex items-center gap-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-primary/90">
                    Begin install{" "}
                    <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* Quick Setup Card */}
          {(() => {
            const activate = () => {
              setSetupMode("quick");
              setCurrentStep(1);
            };

            return (
              <Card
                role="button"
                tabIndex={0}
                aria-describedby="quick-setup-description"
                className="group relative overflow-hidden cursor-pointer border-border/60 bg-card transition-[border-color,box-shadow,transform] hover:border-primary/40 hover:shadow-md hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onClick={activate}
                onKeyDown={(event) => handleCardKeyDown(event, activate)}
              >
                <CardHeader className="pb-3">
                  <div className="grid place-items-center w-11 h-11 rounded-md border border-border/55 bg-muted/40 text-muted-foreground mb-3 transition-colors group-hover:border-primary/30 group-hover:bg-primary/[0.06] group-hover:text-primary">
                    <Plus className="w-5 h-5" />
                  </div>
                  <CardTitle className="text-lg">Use Existing Files</CardTitle>
                  <CardDescription
                    id="quick-setup-description"
                    className="text-xs"
                  >
                    Register a server using files you already downloaded
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pb-5">
                  <ul className="space-y-1.5 text-[13px]">
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/70 shrink-0" />
                      <span>No download required</span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/70 shrink-0" />
                      <span>Point to an existing PZ server folder</span>
                    </li>
                    <li className="flex items-start gap-2 text-muted-foreground">
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/70 shrink-0" />
                      <span>Fast 3-step setup</span>
                    </li>
                  </ul>
                  <div className="flex items-center gap-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors group-hover:text-primary/90">
                    Register server{" "}
                    <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </CardContent>
              </Card>
            );
          })()}
        </div>

        {/* Quick Tips */}
        <Card className="bg-secondary/40 border-border/70 shadow-sm">
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg border border-primary/20 bg-primary/10 flex items-center justify-center shrink-0">
                <Info className="w-5 h-5 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="font-medium">Not sure which to choose?</p>
                <p className="text-sm text-muted-foreground">
                  If you've never set up a Project Zomboid server before, choose{" "}
                  <strong>Fresh Install</strong>. It will download everything
                  you need automatically.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Step indicator
  const renderStepIndicator = () => {
    const steps =
      setupMode === "quick"
        ? [
            { id: 1, label: "Location", icon: HardDrive },
            { id: 2, label: "Configure", icon: Settings2 },
            { id: 3, label: "Create", icon: Plus },
          ]
        : [
            { id: 1, label: "SteamCMD", icon: Download },
            { id: 2, label: "Server", icon: Server },
            { id: 3, label: "Settings", icon: Settings2 },
            { id: 4, label: "Install", icon: Zap },
          ];

    return (
      <div className="flex items-center justify-center mb-8">
        <div className="flex items-center gap-0">
          {steps.map((step, index) => {
            const Icon = step.icon;
            const isActive = currentStep === step.id;
            const isComplete = currentStep > step.id;
            const isClickable =
              step.id <= currentStep ||
              stepValidation[step.id as keyof typeof stepValidation];

            return (
              <div key={step.id} className="flex items-center">
                <button
                  onClick={() => isClickable && setCurrentStep(step.id)}
                  disabled={!isClickable}
                  aria-current={isActive ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 sm:px-3.5 sm:py-2 rounded-full border transition-colors",
                    isActive &&
                      "border-primary bg-primary text-primary-foreground shadow-sm",
                    !isActive &&
                      isComplete &&
                      "border-primary/40 bg-primary/[0.08] text-primary",
                    !isActive &&
                      !isComplete &&
                      "border-border/50 bg-muted/30 text-muted-foreground",
                    isClickable &&
                      !isActive &&
                      "hover:border-primary/40 hover:bg-muted/60 cursor-pointer",
                  )}
                >
                  {isComplete ? (
                    <CheckCircle className="w-4 h-4" />
                  ) : (
                    <Icon className="w-4 h-4" />
                  )}
                  <span className="text-[11px] font-medium uppercase tracking-wide hidden sm:inline">
                    {step.label}
                  </span>
                </button>
                {index < steps.length - 1 && (
                  <span
                    className={cn(
                      "w-6 sm:w-10 h-px mx-1",
                      isComplete ? "bg-primary/50" : "bg-border/60",
                    )}
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Full Install Step 1: SteamCMD
  const renderFullStep1 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Set Up SteamCMD</h2>
        <p className="text-muted-foreground">
          SteamCMD is required to download and update Project Zomboid dedicated
          server files.
        </p>
      </div>

      {!hasSteamCmd ? (
        <div className="space-y-6">
          {/* One-Click Setup */}
          <Card className="border-primary/35 bg-card shadow-sm">
            <CardContent className="pt-6">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
                  <Sparkles className="w-6 h-6 text-primary" />
                </div>
                <div className="flex-1 space-y-4">
                  <div>
                    <h3 className="font-semibold text-lg">One-Click Setup</h3>
                    <p className="text-sm text-muted-foreground">
                      We will install SteamCMD and prepare it for this panel.
                    </p>
                  </div>

                  <div className="flex gap-2 items-center">
                    <Input
                      value={steamCmdPath}
                      onChange={(e) => setSteamCmdPath(e.target.value)}
                      placeholder="Select or enter the SteamCMD folder path"
                      className="font-mono flex-1"
                      disabled={downloadingSteamCmd}
                      maxLength={260}
                    />
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() =>
                              handleBrowseFolder(
                                setSteamCmdPath,
                                "Select SteamCMD folder",
                                steamCmdPath,
                              )
                            }
                            disabled={downloadingSteamCmd}
                            aria-label="Browse SteamCMD folder"
                          >
                            <FolderOpen className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Browse folder</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>

                  <Button
                    onClick={handleAutoDownloadSteamCmd}
                    disabled={downloadingSteamCmd}
                    className="w-full"
                    size="lg"
                  >
                    {downloadingSteamCmd ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        {steamCmdStatus || "Installing SteamCMD..."}
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4 mr-2" />
                        Install SteamCMD Automatically
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Manual Setup Accordion */}
          <Accordion type="single" collapsible className="border rounded-lg">
            <AccordionItem value="manual" className="border-0">
              <AccordionTrigger className="px-4 hover:no-underline">
                <div className="flex items-center gap-2">
                  <Settings2 className="w-4 h-4" />
                  <span>Already have SteamCMD? Set the folder manually</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4">
                <div className="space-y-4">
                  <div className="bg-warning/10 border border-warning/40 rounded-lg p-4 text-sm shadow-sm">
                    <p className="font-medium text-warning">Manual Setup</p>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground mt-2">
                      <li>Download SteamCMD from Valve</li>
                      <li>
                        Extract to a folder (e.g.,{" "}
                        <code className="bg-muted px-1 rounded">
                          C:\SteamCMD
                        </code>{" "}
                        or{" "}
                        <code className="bg-muted px-1 rounded">
                          ~/steamcmd
                        </code>
                        )
                      </li>
                      <li>
                        Run{" "}
                        <code className="bg-muted px-1 rounded">steamcmd</code>{" "}
                        once so it can self-update
                      </li>
                    </ol>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() =>
                        window.open(
                          "https://developer.valvesoftware.com/wiki/SteamCMD#Downloading_SteamCMD",
                          "_blank",
                        )
                      }
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download SteamCMD
                      <ExternalLink className="w-3 h-3 ml-2" />
                    </Button>
                  </div>

                  <div className="flex gap-2">
                    <Input
                      value={steamCmdPath}
                      onChange={(e) => setSteamCmdPath(e.target.value)}
                      placeholder="Path to your existing SteamCMD folder"
                      className="font-mono flex-1"
                      maxLength={260}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() =>
                        handleBrowseFolder(
                          setSteamCmdPath,
                          "Select SteamCMD folder",
                          steamCmdPath,
                        )
                      }
                      aria-label="Browse SteamCMD folder"
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                    <Button onClick={handleSaveSteamCmdPath}>Save Path</Button>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      ) : (
        <Card className="border-primary/30 bg-card shadow-sm">
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl border border-primary/25 bg-primary/14 flex items-center justify-center">
                <CheckCircle className="w-6 h-6 text-primary" />
              </div>
              <div className="flex-1">
                <p className="font-semibold">SteamCMD Ready</p>
                <p className="text-sm text-muted-foreground font-mono">
                  {steamCmdPath}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHasSteamCmd(false)}
              >
                Change Path
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );

  // Full Install Step 2: Server Location & Name
  const renderFullStep2 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Server Details</h2>
        <p className="text-muted-foreground">
          Choose where files are installed and set the server identity.
        </p>
      </div>

      <div className="grid gap-6">
        {/* Installation Path */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-base">Install Folder</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-0 text-xs"
              onClick={() => setInstallPath(LINUX_SERVICE_INSTALL_PATH)}
            >
              Use Linux service path
            </Button>
          </div>
          <div className="flex gap-2">
            <Input
              value={installPath}
              onChange={(e) => setInstallPath(e.target.value)}
              placeholder="Folder where server files will be installed"
              className="font-mono flex-1"
              maxLength={260}
            />
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() =>
                      handleBrowseFolder(
                        setInstallPath,
                        "Select server folder",
                        installPath,
                      )
                    }
                    aria-label="Browse install folder"
                  >
                    <FolderOpen className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Browse folder</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="text-xs text-muted-foreground">
            SteamCMD downloads approximately 3 GB here. The panel service must
            be allowed to write to this folder.
          </p>
        </div>

        <div className="border border-border/60 bg-muted/40 rounded-lg p-4 text-sm space-y-2">
          <p className="font-medium flex items-center gap-2">
            <Info className="w-4 h-4 text-primary" />
            Linux service installs
          </p>
          <p className="text-muted-foreground">
            If the panel runs through the bundled systemd service, use{" "}
            <code className="bg-muted px-1 rounded">{LINUX_SERVICE_INSTALL_PATH}</code>.
            Other folders require a systemd permission change.
          </p>
          <p className="text-muted-foreground">
            The server data folder is created beside the install folder: {" "}
            <code className="bg-muted px-1 rounded break-all">
              {installPath.trim() ? `${installPath.trim()}_Data` : "your-install-folder_Data"}
            </code>. Both folders must be writable.
          </p>
        </div>

        {/* Server Name */}
        <div className="space-y-2">
          <Label className="text-base">Server Name</Label>
          <Input
            value={serverName}
            onChange={(e) =>
              setServerName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))
            }
            placeholder="myserver"
            className="font-mono"
            maxLength={64}
          />
          <p className="text-xs text-muted-foreground">
            Alphanumeric and underscores only. Used for config files.
          </p>
        </div>

        {/* Branch Selection */}
        <div className="space-y-2">
          <Label className="text-base">Game Version</Label>
          <Select
            value={branch}
            onValueChange={setBranch}
            disabled={loadingBranches}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  loadingBranches
                    ? "Loading available versions..."
                    : "Select game version"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {availableBranches.map((b) => (
                <SelectItem key={b.name} value={b.name}>
                  <div className="flex flex-col">
                    <span>
                      {b.name === "public"
                        ? "Build 42 (Stable)"
                        : b.description || b.name}
                    </span>
                    {b.buildId && (
                      <span className="text-xs text-muted-foreground">
                        Build: {b.buildId}
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Custom Data Path - Collapsed by default */}
        <Accordion type="single" collapsible className="border rounded-lg">
          <AccordionItem value="datapath" className="border-0">
            <AccordionTrigger className="px-4 hover:no-underline">
              <div className="flex items-center gap-2 text-sm">
                <FolderOpen className="w-4 h-4" />
                <span>Custom config location</span>
                {useCustomDataPath && zomboidDataPath && (
                  <Badge variant="secondary" className="ml-2">
                    Set
                  </Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Leave this blank to create a data folder beside the install
                  folder. In Docker, choose a bind-mounted folder when
                  overriding it.
                </p>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={useCustomDataPath}
                    onCheckedChange={setUseCustomDataPath}
                  />
                  <Label>Use custom location</Label>
                </div>
                {useCustomDataPath && (
                  <div className="flex gap-2">
                    <Input
                      value={zomboidDataPath}
                      onChange={(e) => setZomboidDataPath(e.target.value)}
                      placeholder="Custom data folder path"
                      className="font-mono flex-1"
                      maxLength={260}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() =>
                        handleBrowseFolder(
                          setZomboidDataPath,
                          "Select config folder",
                          zomboidDataPath,
                        )
                      }
                      aria-label="Browse config folder"
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  );

  // Full Install Step 3: RCON & Performance
  const renderFullStep3 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Server Settings</h2>
        <p className="text-muted-foreground">
          Configure remote control access and runtime options.
        </p>
      </div>

      {/* RCON Section - Critical */}
      <Card className="border-primary/35 bg-card shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">Remote Control (RCON)</CardTitle>
            <Badge className="ml-auto">Required</Badge>
          </div>
          <CardDescription>
            This panel uses RCON to run commands on your server.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>RCON Password</Label>
              <div className="flex gap-1">
                <div className="relative flex-1">
                  <Input
                    type={showRconPassword ? "text" : "password"}
                    value={rconPassword}
                    onChange={(e) => setRconPassword(e.target.value)}
                    className="pr-10 font-mono"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1 h-9 w-9 p-0"
                    onClick={() => setShowRconPassword(!showRconPassword)}
                    aria-label={
                      showRconPassword
                        ? "Hide RCON password"
                        : "Show RCON password"
                    }
                  >
                    {showRconPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleCopyPassword}
                        aria-label="Copy password"
                      >
                        {copiedPassword ? (
                          <Check className="w-4 h-4" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy password</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleRegeneratePassword}
                        aria-label="Generate new password"
                      >
                        <RefreshCw className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Generate new password</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {rconPassword.length > 0 && rconPassword.length < 6 && (
                <p className="text-xs text-destructive">Minimum 6 characters</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>RCON Port</Label>
              <Input
                type="number"
                value={rconPort}
                onChange={(e) => setRconPort(parseInt(e.target.value) || 27015)}
                className="font-mono"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Memory Settings */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-5 h-5" />
              <CardTitle className="text-lg">Memory Allocation</CardTitle>
            </div>
            {detectingRam ? (
              <Badge variant="outline" className="animate-pulse">
                Detecting RAM...
              </Badge>
            ) : (
              systemRam && (
                <Badge variant="outline">
                  {systemRam.totalGB} GB RAM detected
                </Badge>
              )
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Label>Minimum RAM</Label>
                <Input
                  type="number"
                  min={1}
                  max={64}
                  value={minMemory}
                  className="h-8 w-20 bg-background text-right font-mono"
                  onChange={e => {
                    const value = Math.min(64, Math.max(1, parseInt(e.target.value, 10) || 1))
                    setMinMemory(value)
                    if (value > maxMemory) setMaxMemory(value)
                  }}
                  aria-label="Minimum RAM in GB"
                />
              </div>
              <Slider
                value={[Math.min(minMemory, 64)]}
                onValueChange={([val]) => {
                  setMinMemory(val);
                  if (val > maxMemory) setMaxMemory(val);
                }}
                min={2}
                max={64}
                step={1}
                aria-label={`Minimum RAM: ${minMemory}GB`}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Label>Maximum RAM</Label>
                <Input
                  type="number"
                  min={1}
                  max={128}
                  value={maxMemory}
                  className="h-8 w-20 bg-background text-right font-mono"
                  onChange={e => {
                    const value = Math.min(128, Math.max(1, parseInt(e.target.value, 10) || 1))
                    setMaxMemory(value)
                    if (value < minMemory) setMinMemory(value)
                  }}
                  aria-label="Maximum RAM in GB"
                />
              </div>
              <Slider
                value={[Math.min(maxMemory, 64)]}
                onValueChange={([val]) => {
                  setMaxMemory(val);
                  if (val < minMemory) setMinMemory(val);
                }}
                min={2}
                max={64}
                step={1}
                aria-label={`Maximum RAM: ${maxMemory}GB`}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Advanced Options - Collapsed */}
      <Accordion type="single" collapsible className="border rounded-lg">
        <AccordionItem value="advanced" className="border-0">
          <AccordionTrigger className="px-4 hover:no-underline">
            <div className="flex items-center gap-2">
              <Settings2 className="w-4 h-4" />
              <span>Advanced Options</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Game Port</Label>
                <Input
                  type="number"
                  value={serverPort}
                  onChange={(e) =>
                    setServerPort(parseInt(e.target.value) || 16261)
                  }
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Default port: 16261
                </p>
              </div>

              <div className="space-y-2">
                <Label>
                  Admin Password <span className="text-destructive">*</span>
                </Label>
                <div className="relative">
                  <Input
                    type={showAdminPassword ? "text" : "password"}
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    placeholder="Required before first server start"
                    className="pr-10"
                    maxLength={128}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1 h-9 w-9 p-0"
                    onClick={() => setShowAdminPassword(!showAdminPassword)}
                    aria-label={
                      showAdminPassword
                        ? "Hide admin password"
                        : "Show admin password"
                    }
                  >
                    {showAdminPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Required before first server start.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">UPnP</p>
                  <p className="text-xs text-muted-foreground">
                    Attempt automatic router port forwarding
                  </p>
                </div>
                <Switch
                  checked={useUpnp}
                  onCheckedChange={setUseUpnp}
                  aria-label="Enable UPnP"
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">No Steam</p>
                  <p className="text-xs text-muted-foreground">
                    Use non-Steam mode (for GOG and LAN setups)
                  </p>
                </div>
                <Switch
                  checked={useNoSteam}
                  onCheckedChange={setUseNoSteam}
                  aria-label="Enable no-Steam mode"
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">Debug</p>
                  <p className="text-xs text-muted-foreground">
                    Enable verbose startup and runtime logs
                  </p>
                </div>
                <Switch
                  checked={useDebug}
                  onCheckedChange={setUseDebug}
                  aria-label="Enable debug mode"
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );

  // Full Install Step 4: Review & Install
  const renderFullStep4 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Review and Install</h2>
        <p className="text-muted-foreground">
          Confirm your settings, then begin the server download.
        </p>
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Installation Path</span>
              <span className="font-mono text-right max-w-[300px] truncate">
                {installPath}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Server Name</span>
              <span className="font-mono">{serverName}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Game Version</span>
              <span>{branch === "public" ? "Build 42 (Stable)" : branch}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Memory</span>
              <span className="font-mono">
                {minMemory}GB - {maxMemory}GB
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Game Port</span>
              <span className="font-mono">{serverPort}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">RCON Port</span>
              <span className="font-mono">{rconPort}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Port Info */}
      <div className="bg-muted/50 border border-border/60 rounded-lg p-4 text-sm shadow-sm">
        <p className="font-medium flex items-center gap-2">
          <Info className="w-4 h-4 text-primary" />
          Firewall / Port Forwarding
        </p>
        <p className="text-muted-foreground mt-1">
          Make sure your firewall or router allows:
        </p>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li>
            • <code className="bg-muted px-1 rounded">{serverPort}</code> UDP -
            Game traffic
          </li>
          <li>
            • <code className="bg-muted px-1 rounded">{serverPort + 1}</code>{" "}
            UDP - Direct connect
          </li>
        </ul>
      </div>

      {/* Install Button */}
      <Button
        onClick={handleInstall}
        disabled={installing || missingAdminPassword}
        className="w-full"
        size="lg"
      >
        {installing ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Installing server... check the log below
          </>
        ) : (
          <>
            <Download className="w-4 h-4 mr-2" />
            Install Project Zomboid Server
          </>
        )}
      </Button>

      {missingAdminPassword && (
        <p className="text-sm text-warning">
          Add an Admin Password in Advanced Options before installing.
        </p>
      )}

      {/* Installation Progress Bar */}
      {installing && installProgress && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {installProgress.status}
            </span>
            <span className="font-mono">
              {installProgress.percent.toFixed(0)}%
              {installProgress.downloaded && installProgress.total && (
                <span className="text-muted-foreground ml-2">
                  ({installProgress.downloaded} / {installProgress.total})
                </span>
              )}
            </span>
          </div>
          <Progress value={installProgress.percent} className="h-2" />
        </div>
      )}

      {/* Installation Log */}
      {logs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4" />
            <span className="text-sm font-medium">Installation Log</span>
          </div>
          <ScrollArea className="h-[200px] bg-black rounded-lg p-3">
            <div className="font-mono text-xs space-y-0.5">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={cn(
                    log.type === "error" || log.type === "stderr"
                      ? "text-destructive"
                      : log.type === "success"
                        ? "text-success"
                        : log.type === "command"
                          ? "text-primary"
                          : "text-foreground/80",
                  )}
                >
                  {log.message}
                </div>
              ))}
              {installing && (
                <div className="text-muted-foreground animate-pulse">...</div>
              )}
              <div ref={logsEndRef} />
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Post-install */}
      {installComplete && (
        <Card className="border-primary/32 bg-card shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center gap-2 text-primary">
              <CheckCircle className="w-5 h-5" />
              <span className="font-medium">Installation Complete</span>
            </div>

            {/* First-run setup notice */}
            <div className="bg-warning/10 border border-warning/40 rounded-lg p-4 text-sm shadow-sm">
              <p className="font-medium flex items-center gap-2 text-warning">
                <Info className="w-4 h-4" />
                First Start Required
              </p>
              <p className="text-muted-foreground mt-1">
                Start the server once to generate configuration files and world
                data. The first startup can take up to a minute.
              </p>
            </div>

            <div className="flex gap-3">
              <Button
                onClick={async () => {
                  setStartingServer(true);
                  try {
                    await serverApi.start();
                    toast({
                      title: "Server Starting",
                      description: "Redirecting to the dashboard...",
                    });
                    navigateTimerRef.current = setTimeout(
                      () => navigate("/"),
                      2000,
                    );
                  } catch (error) {
                    toast({
                      title: "Start Failed",
                      description:
                        error instanceof Error
                          ? error.message
                          : "Unknown error",
                      variant: "destructive",
                    });
                  } finally {
                    setStartingServer(false);
                  }
                }}
                disabled={startingServer}
                className="flex-1"
              >
                {startingServer ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />{" "}
                    Starting...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" /> Start Server
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={() => navigate("/")}>
                Open Dashboard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );

  // Quick Setup Step 1: Select Files
  const renderQuickStep1 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Select Server Files</h2>
        <p className="text-muted-foreground">
          Choose the existing Project Zomboid dedicated server folder.
        </p>
      </div>

      <Card className="bg-secondary/40 border-primary/24 shadow-sm">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg border border-primary/20 bg-primary/10 flex items-center justify-center shrink-0">
              <HardDrive className="w-5 h-5 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">Using existing files</p>
              <p className="text-sm text-muted-foreground">
                The folder should contain{" "}
                <code className="bg-muted px-1 rounded">StartServer64.bat</code>{" "}
                (Windows) or{" "}
                <code className="bg-muted px-1 rounded">start-server.sh</code>{" "}
                (Linux), plus the{" "}
                <code className="bg-muted px-1 rounded">java</code> folder.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <Label className="text-base">Server Files Location</Label>
        <div className="flex gap-2">
          <Input
            value={installPath}
            onChange={(e) => setInstallPath(e.target.value)}
            placeholder="Path to your existing dedicated server folder"
            className="font-mono flex-1"
            maxLength={260}
          />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() =>
                    handleBrowseFolder(
                      setInstallPath,
                      "Select PZ server folder",
                      installPath,
                    )
                  }
                  aria-label="Browse server files folder"
                >
                  <FolderOpen className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Browse folder</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <p className="text-xs text-muted-foreground">
          Folder that already contains your Project Zomboid dedicated server
          files.
        </p>
      </div>
    </div>
  );

  // Quick Setup Step 2: Configure
  const renderQuickStep2 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Configure Server</h2>
        <p className="text-muted-foreground">
          Set server name, RCON access, and memory limits.
        </p>
      </div>

      <div className="grid gap-6">
        {/* Server Name */}
        <div className="space-y-2">
          <Label className="text-base">Server Name</Label>
          <Input
            value={serverName}
            onChange={(e) =>
              setServerName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))
            }
            placeholder="myserver"
            className="font-mono"
            maxLength={64}
          />
          <p className="text-xs text-muted-foreground">
            Each server needs a unique name. Creates separate config files.
          </p>
        </div>

        {/* RCON - Critical */}
        <Card className="border-primary/35 bg-card shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <CardTitle className="text-lg">Remote Control (RCON)</CardTitle>
              <Badge className="ml-auto">Required</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>RCON Password</Label>
                <div className="flex gap-1">
                  <div className="relative flex-1">
                    <Input
                      type={showRconPassword ? "text" : "password"}
                      value={rconPassword}
                      onChange={(e) => setRconPassword(e.target.value)}
                      className="pr-10 font-mono"
                      maxLength={128}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1 h-9 w-9 p-0"
                      onClick={() => setShowRconPassword(!showRconPassword)}
                      aria-label={
                        showRconPassword
                          ? "Hide RCON password"
                          : "Show RCON password"
                      }
                    >
                      {showRconPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={handleCopyPassword}
                          aria-label="Copy password"
                        >
                          {copiedPassword ? (
                            <Check className="w-4 h-4" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Copy password</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={handleRegeneratePassword}
                          aria-label="Generate new password"
                        >
                          <RefreshCw className="w-4 h-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Generate new password</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                {rconPassword.length > 0 && rconPassword.length < 6 && (
                  <p className="text-xs text-destructive">
                    Minimum 6 characters
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label>RCON Port</Label>
                <Input
                  type="number"
                  value={rconPort}
                  onChange={(e) =>
                    setRconPort(parseInt(e.target.value) || 27015)
                  }
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Default port: 27015
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Memory */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-5 h-5" />
                <CardTitle className="text-lg">Memory Allocation</CardTitle>
              </div>
              {detectingRam ? (
                <Badge variant="outline" className="animate-pulse">
                  Detecting RAM...
                </Badge>
              ) : (
                systemRam && (
                  <Badge variant="outline">
                    {systemRam.totalGB} GB detected
                  </Badge>
                )
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <Label>Minimum RAM</Label>
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    value={minMemory}
                    className="h-8 w-20 bg-background text-right font-mono"
                    onChange={e => {
                      const value = Math.min(64, Math.max(1, parseInt(e.target.value, 10) || 1))
                      setMinMemory(value)
                      if (value > maxMemory) setMaxMemory(value)
                    }}
                    aria-label="Minimum RAM in GB"
                  />
                </div>
                <Slider
                  value={[Math.min(minMemory, 64)]}
                  onValueChange={([val]) => {
                    setMinMemory(val);
                    if (val > maxMemory) setMaxMemory(val);
                  }}
                  min={2}
                  max={64}
                  step={1}
                  aria-label={`Minimum RAM: ${minMemory}GB`}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <Label>Maximum RAM</Label>
                  <Input
                    type="number"
                    min={1}
                    max={128}
                    value={maxMemory}
                    className="h-8 w-20 bg-background text-right font-mono"
                    onChange={e => {
                      const value = Math.min(128, Math.max(1, parseInt(e.target.value, 10) || 1))
                      setMaxMemory(value)
                      if (value < minMemory) setMinMemory(value)
                    }}
                    aria-label="Maximum RAM in GB"
                  />
                </div>
                <Slider
                  value={[Math.min(maxMemory, 64)]}
                  onValueChange={([val]) => {
                    setMaxMemory(val);
                    if (val < minMemory) setMinMemory(val);
                  }}
                  min={2}
                  max={64}
                  step={1}
                  aria-label={`Maximum RAM: ${maxMemory}GB`}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Advanced Options */}
        <Accordion type="single" collapsible className="border rounded-lg">
          <AccordionItem value="advanced" className="border-0">
            <AccordionTrigger className="px-4 hover:no-underline">
              <div className="flex items-center gap-2">
                <Settings2 className="w-4 h-4" />
                <span>Advanced Options</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4 space-y-4">
              <div className="flex items-center gap-3">
                <Switch
                  checked={useCustomDataPath}
                  onCheckedChange={setUseCustomDataPath}
                />
                <Label>Custom config location</Label>
              </div>
              {useCustomDataPath && (
                <div className="flex gap-2">
                  <Input
                    value={zomboidDataPath}
                    onChange={(e) => setZomboidDataPath(e.target.value)}
                    placeholder="Custom data folder path"
                    className="font-mono flex-1"
                    maxLength={260}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() =>
                      handleBrowseFolder(
                        setZomboidDataPath,
                        "Select config folder",
                        zomboidDataPath,
                      )
                    }
                    aria-label="Browse config folder"
                  >
                    <FolderOpen className="w-4 h-4" />
                  </Button>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Game Port</Label>
                  <Input
                    type="number"
                    value={serverPort}
                    onChange={(e) =>
                      setServerPort(parseInt(e.target.value) || 16261)
                    }
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    Default port: 16261
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>
                    Admin Password <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <Input
                      type={showAdminPassword ? "text" : "password"}
                      value={adminPassword}
                      onChange={(e) => setAdminPassword(e.target.value)}
                      placeholder="Required before first server start"
                      className="pr-10"
                      maxLength={128}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1 h-9 w-9 p-0"
                      onClick={() => setShowAdminPassword(!showAdminPassword)}
                      aria-label={
                        showAdminPassword
                          ? "Hide admin password"
                          : "Show admin password"
                      }
                    >
                      {showAdminPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Required before first server start.
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">UPnP</p>
                    <p className="text-xs text-muted-foreground">
                      Attempt automatic router port forwarding
                    </p>
                  </div>
                  <Switch
                    checked={useUpnp}
                    onCheckedChange={setUseUpnp}
                    aria-label="Enable UPnP"
                  />
                </div>
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">No Steam</p>
                    <p className="text-xs text-muted-foreground">
                      Use non-Steam mode (for GOG and LAN setups)
                    </p>
                  </div>
                  <Switch
                    checked={useNoSteam}
                    onCheckedChange={setUseNoSteam}
                    aria-label="Enable no-Steam mode"
                  />
                </div>
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="text-sm font-medium">Debug</p>
                    <p className="text-xs text-muted-foreground">
                      Enable verbose startup and runtime logs
                    </p>
                  </div>
                  <Switch
                    checked={useDebug}
                    onCheckedChange={setUseDebug}
                    aria-label="Enable debug mode"
                  />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  );

  // Quick Setup Step 3: Create
  const renderQuickStep3 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Review and Create</h2>
        <p className="text-muted-foreground">
          Confirm these settings, then create your server entry.
        </p>
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Server Files</span>
              <span className="font-mono text-right max-w-[300px] truncate">
                {installPath}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Server Name</span>
              <span className="font-mono">{serverName}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Memory</span>
              <span className="font-mono">
                {minMemory}GB - {maxMemory}GB
              </span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Game Port</span>
              <span className="font-mono">{serverPort}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">RCON Port</span>
              <span className="font-mono">{rconPort}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Create Button */}
      <Button
        onClick={handleQuickSetup}
        disabled={installing || missingAdminPassword}
        className="w-full"
        size="lg"
      >
        {installing ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Creating server...
          </>
        ) : (
          <>
            <Plus className="w-4 h-4 mr-2" />
            Create Server
          </>
        )}
      </Button>

      {missingAdminPassword && (
        <p className="text-sm text-warning">
          Add an Admin Password in Advanced Options before creating the server.
        </p>
      )}

      {/* Log */}
      {logs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4" />
            <span className="text-sm font-medium">Setup Log</span>
          </div>
          <ScrollArea className="h-[150px] bg-black rounded-lg p-3">
            <div className="font-mono text-xs space-y-0.5">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={cn(
                    log.type === "error"
                      ? "text-destructive"
                      : log.type === "success"
                        ? "text-success"
                        : "text-foreground/80",
                  )}
                >
                  {log.message}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Post-create */}
      {installComplete && (
        <Card className="border-primary/30 bg-card shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center gap-2 text-primary">
              <CheckCircle className="w-5 h-5" />
              <span className="font-medium">Server Created!</span>
            </div>

            <div className="flex gap-3">
              <Button
                onClick={async () => {
                  setStartingServer(true);
                  try {
                    await serverApi.start();
                    toast({
                      title: "Server Starting",
                      description: "Redirecting to the dashboard...",
                    });
                    navigateTimerRef.current = setTimeout(
                      () => navigate("/"),
                      2000,
                    );
                  } catch (error) {
                    toast({
                      title: "Start Failed",
                      description:
                        error instanceof Error
                          ? error.message
                          : "Unknown error",
                      variant: "destructive",
                    });
                  } finally {
                    setStartingServer(false);
                  }
                }}
                disabled={startingServer}
                className="flex-1"
              >
                {startingServer ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />{" "}
                    Starting...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" /> Start Server
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={() => navigate("/")}>
                Open Dashboard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );

  // Render current step content
  const renderStepContent = () => {
    if (setupMode === "quick") {
      switch (currentStep) {
        case 1:
          return renderQuickStep1();
        case 2:
          return renderQuickStep2();
        case 3:
          return renderQuickStep3();
      }
    } else {
      switch (currentStep) {
        case 1:
          return renderFullStep1();
        case 2:
          return renderFullStep2();
        case 3:
          return renderFullStep3();
        case 4:
          return renderFullStep4();
      }
    }
  };

  const isLastStep = currentStep === totalSteps;

  const getStepRequirementMessage = () => {
    if (setupMode === "quick") {
      if (currentStep === 1)
        return "Select the dedicated server folder to continue.";
      if (currentStep === 2) {
        if (!serverName.trim() && rconPassword.length < 6)
          return "Enter a server name and an RCON password (minimum 6 characters).";
        if (!serverName.trim()) return "Enter a server name to continue.";
        if (rconPassword.length < 6)
          return "RCON password must be at least 6 characters.";
      }
      return "";
    }

    if (currentStep === 1) {
      if (!steamCmdPath.trim())
        return "Set a SteamCMD folder path to continue.";
      if (!hasSteamCmd) return "Install or confirm SteamCMD to continue.";
    }
    if (currentStep === 2) {
      if (!installPath.trim() && !serverName.trim())
        return "Set an install folder and server name to continue.";
      if (!installPath.trim()) return "Set an install folder to continue.";
      if (!serverName.trim()) return "Enter a server name to continue.";
    }
    if (currentStep === 3 && rconPassword.length < 6)
      return "RCON password must be at least 6 characters.";
    return "";
  };

  return (
    <>
      <div className="max-w-3xl mx-auto space-y-6 page-transition">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold">
            {setupMode === "quick" ? "Quick Setup" : "Fresh Install"}
          </h1>
          <p className="text-muted-foreground">
            {setupMode === "quick"
              ? "Create and register a server using existing dedicated server files."
              : "Download, configure, and register a new dedicated server."}
          </p>
        </div>

        {/* Step Indicator */}
        {renderStepIndicator()}

        {/* Main Content Card */}
        <Card>
          <CardContent className="pt-6">{renderStepContent()}</CardContent>
        </Card>

        {/* Navigation */}
        {!isLastStep && (
          <div className="space-y-2">
            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => {
                  if (currentStep === 1) {
                    setSetupMode("select");
                  } else {
                    setCurrentStep((s) => s - 1);
                  }
                }}
              >
                <ChevronLeft className="w-4 h-4 mr-2" />
                {currentStep === 1 ? "Choose Setup Type" : "Back"}
              </Button>

              <Button
                onClick={() => setCurrentStep((s) => s + 1)}
                disabled={!canProceed}
              >
                Next Step
                <ChevronRight className="w-4 h-4 ml-2" />
              </Button>
            </div>

            {!canProceed && (
              <p className="text-sm text-warning">
                {getStepRequirementMessage()}
              </p>
            )}
          </div>
        )}

        {isLastStep && !installing && !installComplete && (
          <div className="flex justify-start">
            <Button
              variant="outline"
              onClick={() => setCurrentStep((s) => s - 1)}
            >
              <ChevronLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
          </div>
        )}
      </div>

      <FolderBrowser
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        onSelect={(path) => browseSetter?.fn(path)}
        initialPath={browseSetter?.initial}
        title={browseSetter?.title}
      />
    </>
  );
}
