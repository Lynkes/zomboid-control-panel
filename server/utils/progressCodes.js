/**
 * Single source of truth for every machine-readable `progressCode` a
 * Socket.IO install/SteamCMD progress event carries. Sibling registry to
 * ErrorCode (server/utils/errorCodes.js) but deliberately NOT the same
 * file or field name -- these travel over steamcmd:status, install:log,
 * install:complete, steam:start, steam:log and steamcmd:complete, not
 * res.json() error bodies, and `code` is already a reserved field name
 * there (errors.json/errorCodeRegistry.test.js). Field name on the wire is
 * `progressCode`, never `code`, so this registry's literals can never be
 * mistaken for -- or accidentally scanned by -- the ErrorCode machinery.
 *
 * Every emit site references a code as `ProgressCode.SOME_CODE` (member
 * access), never a bare string literal -- the same discipline errorCodes.js
 * documents for `code:`, enforced here by never writing the wire value as a
 * quoted string anywhere except inside this file. See
 * server/tests/progressCodeRegistry.test.js, which enforces this both ways:
 * every ProgressCode.* reference in server.js is registered here, every
 * entry here is both referenced in source AND has an en (and, transitively
 * via localeParity.test.ts, fr) entry in
 * client/src/locales/{en,fr}/installProgress.json.
 *
 * CONSTANT NAME === WIRE VALUE === LOCALE KEY, always, no exceptions --
 * unlike ErrorCode this registry has no pre-existing legacy wire values to
 * carry forward, so there was no reason to invent the split.
 *
 * THE 12 RAW SteamCMD STDOUT/STDERR PASSTHROUGH SITES DELIBERATELY HAVE NO
 * ENTRY HERE. They are not ours to translate -- they are SteamCMD's own
 * output, forwarded verbatim. They are routed through
 * emitRawSteamCmdLine() in server/routes/server.js, which emits
 * `{type, text}` with no `progressCode` field and no way to attach one --
 * structural, not a comment someone has to remember. A raw line can never
 * carry a progressCode; a line with a progressCode is never raw. See that
 * function's own comment for why this needs to be physically impossible
 * rather than documented (server.js:3026's history, 2026-08-22).
 */

export const ProgressCode = Object.freeze({
  /** ensureSteamCmdLinux() self-heal (2 call sites: /install, /steam-update
   * when steamcmdPath is empty) -- download starting. */
  STEAMCMD_LINUX_AUTO_DOWNLOAD_START: "STEAMCMD_LINUX_AUTO_DOWNLOAD_START",
  /** Shared across 3 call sites with identical wording: ensureSteamCmdLinux
   * (Linux self-heal) and both branches (Windows/Linux) of POST
   * /steamcmd/download -- the extraction step starting. */
  STEAMCMD_EXTRACTING: "STEAMCMD_EXTRACTING",
  /** Shared across 2 call sites with identical wording: ensureSteamCmdLinux
   * and POST /steamcmd/download's runFirstTimeSetup() -- first-run `+quit`
   * about to start. */
  STEAMCMD_INITIALIZING: "STEAMCMD_INITIALIZING",
  /** Shared across 2 call sites with identical wording: ensureSteamCmdLinux
   * and POST /steamcmd/download's runFirstTimeSetup() -- first-run
   * completed successfully. The installed path travels in a separate
   * structured `path` field, not interpolated into this message -- no
   * params. */
  STEAMCMD_INSTALL_COMPLETE: "STEAMCMD_INSTALL_COMPLETE",
  /** POST /api/server/install -- zomboidDataPath was not explicitly
   * configured, so the panel used the operator-provided (already-existing)
   * one. Own code from ..._ISOLATED below: "configured" vs "isolated" is a
   * word choice, not a value, so it's a variant per the params-vs-variant
   * rule, not a shared template with a swapped param. Params: {path}. */
  DATA_FOLDER_USING_CONFIGURED: "DATA_FOLDER_USING_CONFIGURED",
  /** POST /api/server/install -- no zomboidDataPath configured or provided;
   * the panel computed an isolated `<installPath>_Data` folder instead. See
   * ..._CONFIGURED above for why this is a separate code. Params: {path}. */
  DATA_FOLDER_USING_ISOLATED: "DATA_FOLDER_USING_ISOLATED",
  /** POST /api/server/install -- install succeeded but the resolved data
   * folder failed the post-install writable check. `command` is a fully
   * server-built shell command (the remediation example), passed through
   * as a param verbatim -- it is syntax, not prose, and stays identical in
   * every language by design (same reasoning as WRITABLE_PATH_ERROR in
   * errorCodes.js). Params: {path, reason, command}. */
  INSTALL_DATA_FOLDER_NOT_WRITABLE: "INSTALL_DATA_FOLDER_NOT_WRITABLE",
  /** POST /api/server/install -- RCON password/port were saved to settings.
   * Params: {port}. */
  RCON_SETTINGS_SAVED: "RCON_SETTINGS_SAVED",
  /** POST /api/server/install -- a minimal server .ini was pre-created so PZ
   * reads the RCON settings on first boot. No params. */
  INI_PRECREATED_WITH_RCON: "INI_PRECREATED_WITH_RCON",
  /** POST /api/server/install -- custom .bat/.sh startup scripts generated.
   * Params: {scriptName} (a generated filename, not translatable prose). */
  STARTUP_SCRIPT_CREATED: "STARTUP_SCRIPT_CREATED",
  /** POST /api/server/install -- PanelBridge.lua was copied into the fresh
   * install automatically. No params. */
  PANELBRIDGE_AUTO_INSTALLED: "PANELBRIDGE_AUTO_INSTALLED",
  /** POST /api/server/install -- steamcmd.on("close") with exit code 0, the
   * whole install flow finished. No params. */
  INSTALL_COMPLETE_SUCCESS: "INSTALL_COMPLETE_SUCCESS",
  /** POST /api/server/install -- steamcmd.on("close") with a non-zero exit
   * code. Params: {code}. */
  INSTALL_FAILED_EXIT_CODE: "INSTALL_FAILED_EXIT_CODE",
  /** Shared across 3 call sites with identical wording: /install's
   * steamcmd.on("error"), /steam-update's steamcmd.on("error"), and POST
   * /steamcmd/download's runFirstTimeSetup() steamcmd.on("error") -- the
   * spawned SteamCMD process itself could not be started (ENOENT etc, not a
   * non-zero exit). Params: {reason} (raw OS/Node error text -- English
   * only by nature, same known gap as errorCodes.js's DIRECTORY_READ_FAILED
   * {{guidance}}). */
  STEAMCMD_RUN_FAILED: "STEAMCMD_RUN_FAILED",
  /** POST /api/server/steam-update, validateFiles=true -- steam:start emit,
   * the "verify" branch. Own code from ..._UPDATE below -- word choice
   * (verb), not a value, so a variant per the params-vs-variant rule. No
   * params. */
  STEAM_START_VERIFY: "STEAM_START_VERIFY",
  /** POST /api/server/steam-update, validateFiles=false -- steam:start emit,
   * the "update" branch. See ..._VERIFY above. No params. */
  STEAM_START_UPDATE: "STEAM_START_UPDATE",
  /** POST /api/server/steam-update -- steamcmd.on("close"), output matched
   * the depot-access-denied / manifest-blocked signature. Independent of
   * the verify/update distinction (the message never names the operation),
   * so one code covers both. No params. */
  STEAM_DEPOT_ACCESS_DENIED: "STEAM_DEPOT_ACCESS_DENIED",
  /** POST /api/server/steam-update, validateFiles=false, exit code 0.
   * "update" vs "verification" is a word choice, not a value -- own code
   * from ..._VERIFY_COMPLETE_SUCCESS below, same reasoning as
   * STEAM_START_UPDATE/VERIFY. No params. */
  STEAM_UPDATE_COMPLETE_SUCCESS: "STEAM_UPDATE_COMPLETE_SUCCESS",
  /** POST /api/server/steam-update, validateFiles=true, exit code 0. See
   * ..._UPDATE_COMPLETE_SUCCESS above. No params. */
  STEAM_VERIFY_COMPLETE_SUCCESS: "STEAM_VERIFY_COMPLETE_SUCCESS",
  /** POST /api/server/steam-update, validateFiles=false, non-zero exit code,
   * not the depot-denied case. Params: {code}. */
  STEAM_UPDATE_FAILED: "STEAM_UPDATE_FAILED",
  /** POST /api/server/steam-update, validateFiles=true, non-zero exit code,
   * not the depot-denied case. Params: {code}. */
  STEAM_VERIFY_FAILED: "STEAM_VERIFY_FAILED",
  /** POST /api/server/steamcmd/download, Windows branch -- zip download
   * starting. Own wording/code from ..._LINUX below (different platform
   * branch, different English sentence). No params. */
  STEAMCMD_DOWNLOADING: "STEAMCMD_DOWNLOADING",
  /** POST /api/server/steamcmd/download, Windows branch -- the HTTPS
   * download itself failed. Params: {reason}. */
  STEAMCMD_DOWNLOAD_FAILED: "STEAMCMD_DOWNLOAD_FAILED",
  /** POST /api/server/steamcmd/download, Linux branch -- tar.gz download
   * starting. See STEAMCMD_DOWNLOADING above for why this is separate. No
   * params. */
  STEAMCMD_DOWNLOADING_LINUX: "STEAMCMD_DOWNLOADING_LINUX",
  /** POST /api/server/steamcmd/download, Linux branch -- both curl and wget
   * failed. Own wording from STEAMCMD_DOWNLOAD_FAILED above (adds the
   * curl/wget remediation sentence). Params: {reason}. */
  STEAMCMD_DOWNLOAD_FAILED_LINUX: "STEAMCMD_DOWNLOAD_FAILED_LINUX",
  /** Shared across 2 call sites with identical "Extraction failed: X"
   * wording: POST /steamcmd/download's Windows zip-extract catch, and its
   * Linux tar-extract callback error branch. Params: {reason}. */
  STEAMCMD_EXTRACTION_FAILED: "STEAMCMD_EXTRACTION_FAILED",
  /** POST /api/server/steamcmd/download, Linux branch -- `ldconfig -p | grep
   * -c libc.so.6` came back non-zero after extraction, so the 32-bit-library
   * check couldn't confirm they're present. THIS IS OUR OWN AUTHORED TEXT,
   * emitted through steamcmd:log (the event otherwise reserved for raw
   * SteamCMD passthrough) -- the exact call site that motivated
   * emitRawSteamCmdLine() existing at all (2026-08-22). No params. */
  STEAMCMD_32BIT_LIB_WARNING: "STEAMCMD_32BIT_LIB_WARNING",
  /** POST /api/server/steamcmd/download -- runFirstTimeSetup()'s
   * steamcmd.on("close") with a non-zero, non-7 exit code. Params: {code}. */
  STEAMCMD_SETUP_FAILED: "STEAMCMD_SETUP_FAILED",
});
