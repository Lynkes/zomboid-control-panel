// Publishes the PanelBridge Workshop item, or records one published with the
// in-game uploader, and pins its id in pz-mod/workshop/published.json (the
// panel embeds that file per release and never fetches the id).
//
// Path A (steamcmd):
//   node scripts/workshop/publish.mjs --steam-user <account> [--visibility unlisted|public]
//     [--changenote-file f] [--steamcmd <path>] [--dry-run] [--allow-unreleased] [--force]
// Path B (in-game uploader, recommended for the first publish because it
// validates the preview and sets the tags):
//   npm run workshop:build -- --out ~/Zomboid/Workshop
//   (in PZ: Workshop > Upload, confirm "WARNING: Steam Workshop upload requested!")
//   node scripts/workshop/publish.mjs record --from-staged ~/Zomboid/Workshop/ZCPB
//   node scripts/workshop/publish.mjs record --id <n>
//   then move the staged folder out of ~/Zomboid/Workshop before testing on
//   that machine (stagedCopyWarning in lib.mjs says why), and commit
//   published.json for a new item only once the live test has passed.
//
// Credentials: this tool never takes, reads or stores a Steam password or
// Steam Guard code. steamcmd runs attached to the terminal and prompts the
// maintainer itself, so the secret never passes through this process, its
// arguments or its environment.

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { getBridgeVersionStatus } from "../check-bridge-version.mjs";
import { DEFAULT_OUT_DIR, WorkshopBuildError, buildWorkshopItem } from "./build-item.mjs";
import {
  BRIDGE_FILES,
  DEFAULT_STAGED_ITEM_DIR,
  MOD_ID,
  REPO_ROOT,
  STEAM_APP_ID,
  compareSemver,
  expandHome,
  isMainModule,
  isValidWorkshopId,
  isWorkshopStagingFolder,
  normalizeText,
  parseSemver,
  parseWorkshopTxt,
  readPublished,
  readRepoText,
  stagedCopyWarning,
  updatePublishedText,
} from "./lib.mjs";

export const PASSWORD_ENV_VARS = Object.freeze(["STEAM_PASSWORD", "STEAMCMD_PASSWORD", "STEAM_GUARD_CODE"]);
// ERemoteStoragePublishedFileVisibility. Servers log on to Steam anonymously
// (GameServer: SteamGameServer.LogOnAnonymous), so only public and unlisted
// items can be downloaded; friends-only and private are never offered.
export const VISIBILITY_CODES = Object.freeze({ public: "0", unlisted: "3" });
// Steam rejects longer change notes.
const MAX_CHANGENOTE_LENGTH = 8000;

const USAGE = `Usage:
  node scripts/workshop/publish.mjs --steam-user <account> [--visibility unlisted|public]
      [--changenote-file <file>] [--steamcmd <path>] [--dry-run] [--allow-unreleased] [--force]
  node scripts/workshop/publish.mjs record (--from-staged <staged item folder> | --id <workshop id>)
      [--visibility unlisted|public]

Publishes the PanelBridge Steam Workshop item with steamcmd, or records the id
of an item uploaded with the in-game uploader (recommended for the first
publish). Either way the id, version and date go into ${BRIDGE_FILES.published}.

  --steam-user <account>    Steam account that owns the item. steamcmd asks for
                            its password and Steam Guard code itself.
  --visibility <v>          unlisted or public. Default: published.json, else unlisted.
  --changenote-file <file>  Change note text. Default: the Lua header's
                            "vX Changes:" blocks since the last publish.
  --steamcmd <path>         steamcmd executable. Default: steamcmd on PATH.
  --dry-run                 Check everything and print the item.vdf, even when a
                            real run would refuse (it then exits 1); run nothing.
  --allow-unreleased        Publish code that differs from ${BRIDGE_FILES.lock}
                            (live-test iterations only).
  --force                   Publish although this VERSION was already published.
  record --from-staged <d>  Read id= from <d>/workshop.txt (the game writes it back).
                            Then move <d> out of the Workshop folder: while it is
                            there, this machine loads it instead of the download.
  record --id <n>           Record this Workshop item id.`;

const PUBLISH_OPTIONS = {
  "--steam-user": "value",
  "--visibility": "value",
  "--changenote-file": "value",
  "--steamcmd": "value",
  "--dry-run": "flag",
  "--allow-unreleased": "flag",
  "--force": "flag",
};
const RECORD_OPTIONS = { "--from-staged": "value", "--id": "value", "--visibility": "value" };

class PublishError extends Error {}

function parseArgs(argv) {
  const args = [...argv];
  const mode = args[0] === "record" ? "record" : "publish";
  if (mode === "record") args.shift();
  const allowed = mode === "record" ? RECORD_OPTIONS : PUBLISH_OPTIONS;
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    const [name, inlineValue] = raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined];
    if (/^-{1,2}p(ass(word)?)?$/i.test(name) || /pass(word)?/i.test(name)) {
      throw new PublishError(
        "This tool never takes a Steam password. Leave it out: steamcmd prompts for the password and Steam Guard code itself.",
      );
    }
    if (name === "--help" || name === "-h") return { mode: "help", options };
    const kind = allowed[name];
    if (!kind) {
      // Only a name this tool defines is echoed (one from the other mode, say).
      // Anything else may be a password typed the way steamcmd takes it
      // (+login <user> <password>), and a password can look like an option
      // (-Hunter2), so it must not end up on screen or in a terminal log.
      if (name in PUBLISH_OPTIONS || name in RECORD_OPTIONS) {
        throw new PublishError(`Unknown argument for ${mode}: ${name}\n\n${USAGE}`);
      }
      throw new PublishError(
        `Unknown argument for ${mode} (not shown, in case it's a password). This tool never takes a password: ` +
          `steamcmd prompts for it itself.\n\n${USAGE}`,
      );
    }
    if (kind === "flag") {
      if (inlineValue !== undefined) throw new PublishError(`${name} takes no value`);
      options[name.slice(2)] = true;
    } else {
      const value = inlineValue ?? args[++index];
      if (value === undefined || value === "") throw new PublishError(`${name} needs a value`);
      options[name.slice(2)] = value;
    }
  }
  return { mode, options };
}

function resolveVisibility(requested, fallback) {
  const visibility = requested ?? fallback ?? "unlisted";
  if (!(visibility in VISIBILITY_CODES)) {
    throw new PublishError(
      `Visibility ${JSON.stringify(visibility)} isn't allowed: dedicated servers download anonymously, so the item must be public or unlisted`,
    );
  }
  return visibility;
}

export function escapeVdf(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

// steamcmd reads item.vdf with Valve's KeyValues parser, and whether it
// honours \" and \\ there is unknown (LIVE; the Steamworks app_build samples
// write "..\content\" with a literal trailing backslash, which suggests it
// doesn't). A value with no quote and no backslash reads the same either way,
// so none ever reaches the VDF: paths use forward slashes (Windows accepts
// them), straight double quotes in the page text become single quotes (the
// Lua changelog quotes messages), and a backslash in the text is refused
// rather than guessed at. escapeVdf still runs, so spec §8.9's escaping holds.
export function toVdfPath(filePath, separator = path.sep) {
  const converted = separator === "\\" ? String(filePath).replace(/\\/g, "/") : String(filePath);
  if (/["\\]/.test(converted)) {
    throw new PublishError(`${filePath} contains a quote or backslash, which item.vdf can't carry reliably; build from another folder`);
  }
  return converted;
}

function vdfText(field, value) {
  const text = String(value).replace(/"/g, "'");
  if (text.includes("\\")) {
    throw new PublishError(
      `The ${field} contains a backslash, which steamcmd may read as an escape. Reword it` +
        (field === "changenote" ? " (--changenote-file <file> replaces the text taken from the Lua header)." : "."),
    );
  }
  return text;
}

export function renderItemVdf({ workshopId, contentFolder, previewFile, visibility, title, description, changenote }) {
  const fields = [
    ["appid", STEAM_APP_ID],
    ["publishedfileid", workshopId ?? "0"],
    ["contentfolder", contentFolder],
    ["previewfile", previewFile],
    ["visibility", VISIBILITY_CODES[visibility]],
    ["title", vdfText("title", title)],
    ["description", vdfText("description", description)],
    ["changenote", vdfText("changenote", changenote)],
  ];
  for (const [key, value] of fields) {
    if (/["\\]/.test(String(value))) throw new PublishError(`item.vdf ${key} contains a quote or backslash: ${value}`);
  }
  const lines = fields.map(([key, value]) => `  ${`"${key}"`.padEnd(18)}"${escapeVdf(value)}"`);
  return `"workshopitem"\n{\n${lines.join("\n")}\n}\n`;
}

export function readVdfPublishedFileId(vdfText) {
  return /"publishedfileid"\s+"((?:[^"\\]|\\.)*)"/i.exec(vdfText)?.[1] ?? null;
}

// The "vX Changes:" blocks of the PanelBridge.lua header comment that are
// newer than the last published version (only the current one on a first
// publish, not the whole history). "vNEXT" is the not-yet-released block:
// release.ps1 renames it, so it only reaches a change note for unreleased code
// (--allow-unreleased, or a dry run), where VERSION still names the last
// release. It gets its own heading rather than a second "v<VERSION> Changes:".
export function changeNoteFromLua(luaText, { version, publishedVersion }) {
  const header = /--\[\[([\s\S]*?)\]\]/.exec(normalizeText(luaText))?.[1] ?? "";
  const blocks = [];
  let current = null;
  for (const rawLine of header.split("\n")) {
    const line = rawLine.trim();
    const start = /^v(\d+\.\d+\.\d+|NEXT) Changes:$/.exec(line);
    if (start) {
      current = { version: start[1], lines: [] };
      blocks.push(current);
    } else if (!current) {
      continue;
    } else if (!line) {
      current = null;
    } else if (line.startsWith("- ") || !current.lines.length) {
      current.lines.push(line);
    } else {
      current.lines[current.lines.length - 1] += ` ${line}`;
    }
  }
  const wanted = blocks.filter((block) => {
    if (block.version === "NEXT") return true;
    if (compareSemver(block.version, version) > 0) return false;
    return publishedVersion ? compareSemver(block.version, publishedVersion) > 0 : block.version === version;
  });
  if (!wanted.length) return `PanelBridge ${version}`;
  const note = wanted
    .map((block) => [block.version === "NEXT" ? "Unreleased changes:" : `v${block.version} Changes:`, ...block.lines].join("\n"))
    .join("\n\n");
  return note.length > MAX_CHANGENOTE_LENGTH ? `${note.slice(0, MAX_CHANGENOTE_LENGTH - 1)}…` : note;
}

function writePublished(repoRoot, text, updates) {
  fs.writeFileSync(path.join(repoRoot, BRIDGE_FILES.published), updatePublishedText(text, updates));
}

function assertCanRecordId(doc, workshopId) {
  if (!isValidWorkshopId(workshopId)) {
    throw new PublishError(`${JSON.stringify(workshopId)} isn't a Workshop item id`);
  }
  // Every Workshop server lists this id in WorkshopItems=; a different id is a
  // different item that nobody's server downloads.
  if (doc.workshopId && doc.workshopId !== workshopId) {
    throw new PublishError(
      `${BRIDGE_FILES.published} already pins Workshop item ${doc.workshopId}; refusing to replace it with ${workshopId}`,
    );
  }
}

// A push to main that touches pz-mod/ republishes the moving aio Docker image
// (docker-aio-build.yml), and every release embeds published.json, so an id
// committed there reaches operators at once. A new item's id waits for the
// maintainer's live test (which also fills in liveVerified).
function commitAdvice(newItem) {
  return newItem
    ? `Don't commit ${BRIDGE_FILES.published} to main until the live test has passed with it: a push to main that ` +
        "touches pz-mod/ also republishes the aio Docker image, which would offer this untested item to its users. " +
        "Keep it on a branch until then."
    : `Commit ${BRIDGE_FILES.published}.`;
}

function loadPublished(repoRoot) {
  const published = readPublished(repoRoot);
  if (published.errors.length) throw new PublishError(published.errors.join("\n"));
  return published;
}

function loadVersionStatus(repoRoot) {
  const status = getBridgeVersionStatus(repoRoot);
  if (status.parityErrors.length) throw new PublishError(status.parityErrors.join("\n"));
  if (status.lockError) throw new PublishError(status.lockError);
  return status;
}

async function runRecord(options, { repoRoot, now, log, warn }) {
  if (Boolean(options["from-staged"]) === Boolean(options.id)) {
    throw new PublishError("record needs exactly one of --from-staged <staged item folder> or --id <workshop id>");
  }
  const published = loadPublished(repoRoot);
  const status = loadVersionStatus(repoRoot);
  let workshopId = options.id;
  let stagedVisibility = null;
  let stagedDir = null;
  if (options["from-staged"]) {
    stagedDir = path.resolve(expandHome(options["from-staged"]));
    const stagedTxtPath = path.join(stagedDir, "workshop.txt");
    if (!fs.existsSync(stagedTxtPath)) throw new PublishError(`${stagedTxtPath} not found`);
    const staged = parseWorkshopTxt(fs.readFileSync(stagedTxtPath, "utf8"));
    workshopId = staged.id?.trim();
    if (!workshopId) {
      throw new PublishError(`${stagedTxtPath} has no id= line yet; the game writes it after the first successful upload`);
    }
    stagedVisibility = staged.visibility?.trim() || null;
  }
  assertCanRecordId(published.doc, workshopId);
  const visibility = resolveVisibility(options.visibility, stagedVisibility ?? published.doc.visibility);
  if (status.changed) {
    warn(
      `PanelBridge code differs from ${BRIDGE_FILES.lock} (${status.lockVersion}); publishedVersion will say ${status.version}, ` +
        "which may not match what was uploaded. Upload from the tagged release tree.",
    );
  }
  writePublished(repoRoot, published.text, {
    workshopId,
    visibility,
    publishedVersion: status.version,
    publishedAt: now().toISOString(),
  });
  log(`Recorded Workshop item ${workshopId} (PanelBridge ${status.version}, ${visibility}) in ${BRIDGE_FILES.published}.`);
  // The in-game uploader leaves the uploaded copy staged, where it replaces
  // the downloaded item on this machine (see stagedCopyWarning).
  warn(
    stagedDir && isWorkshopStagingFolder(path.dirname(stagedDir))
      ? stagedCopyWarning(stagedDir)
      : `If you uploaded it with the in-game uploader, ${stagedCopyWarning()}`,
  );
  log(commitAdvice(!published.doc.workshopId));
  return 0;
}

async function runPublish(options, { repoRoot, spawn, now, log, warn }) {
  const steamUser = options["steam-user"];
  if (!steamUser) throw new PublishError(`--steam-user <account> is required\n\n${USAGE}`);
  // Steam account names are letters, digits and underscores; anything else
  // (a space in particular) would let a password ride along in the argument.
  if (!/^[A-Za-z0-9_]{1,64}$/.test(steamUser)) {
    throw new PublishError("--steam-user must be a Steam account name (letters, digits, underscore)");
  }
  const published = loadPublished(repoRoot);
  const doc = published.doc;
  const visibility = resolveVisibility(options.visibility, doc.visibility);

  try {
    buildWorkshopItem({ repoRoot, check: true });
  } catch (error) {
    if (error instanceof WorkshopBuildError) throw new PublishError(error.message);
    throw error;
  }
  const status = loadVersionStatus(repoRoot);
  // Release-policy refusals. A dry run still prints the VDF, so the preview
  // shows everything, and then fails with the same reasons a real run would.
  const refusals = [];
  if (status.changed) {
    if (options["allow-unreleased"]) {
      warn(`Publishing UNRELEASED PanelBridge code as ${status.version} (--allow-unreleased). Live-test iterations only.`);
    } else {
      refusals.push(
        `PanelBridge code differs from the released ${status.lockVersion} (${BRIDGE_FILES.lock}). ` +
          "Publish from the tagged release tree, or pass --allow-unreleased for a live-test iteration.",
      );
    }
  }
  if (doc.publishedVersion === status.version && !options.force) {
    refusals.push(
      `PanelBridge ${status.version} is already published. Every publish makes new joins fail on every Workshop server ` +
        "until it restarts, so republishing the same version needs --force.",
    );
  }
  if (refusals.length && !options["dry-run"]) throw new PublishError(refusals.join("\n"));

  const template = parseWorkshopTxt(readRepoText(repoRoot, BRIDGE_FILES.workshopTxt));
  const outDir = path.join(repoRoot, DEFAULT_OUT_DIR);
  const itemDir = path.join(outDir, MOD_ID);
  const vdfPath = path.join(outDir, "item.vdf");
  const changenote = options["changenote-file"]
    ? normalizeText(fs.readFileSync(path.resolve(expandHome(options["changenote-file"])), "utf8")).trim()
    : changeNoteFromLua(readRepoText(repoRoot, BRIDGE_FILES.serverLua), {
      version: status.version,
      publishedVersion: parseSemver(doc.publishedVersion) ? doc.publishedVersion : null,
    });
  if (!changenote) throw new PublishError("The change note is empty");
  const vdf = renderItemVdf({
    workshopId: doc.workshopId,
    contentFolder: toVdfPath(path.join(itemDir, "Contents")),
    previewFile: toVdfPath(path.join(itemDir, "preview.png")),
    visibility,
    title: template.title,
    description: template.descriptionLines.join("\n"),
    changenote,
  });
  const steamcmd = options.steamcmd ?? "steamcmd";
  const steamArgs = ["+login", steamUser, "+workshop_build_item", vdfPath, "+quit"];

  if (options["dry-run"]) {
    log(`Dry run: ${vdfPath} would contain:\n`);
    log(vdf);
    log(`Would run: ${steamcmd} ${steamArgs.join(" ")}`);
    if (refusals.length) throw new PublishError(`A real run would refuse:\n${refusals.join("\n")}`);
    return 0;
  }

  buildWorkshopItem({ repoRoot });
  fs.writeFileSync(vdfPath, vdf);
  log(
    `Publishing as ${steamUser}. Workshop items can't be transferred to another account later. Use the project's dedicated ` +
      "Steam account (owns Project Zomboid, mobile authenticator, Workshop Legal Agreement accepted, or the item stays hidden).",
  );
  log("steamcmd keeps its own login session; use its logout command on shared machines.");
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(steamcmd, steamArgs, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  // steamcmd writes the new item's id back into the VDF on the first publish
  // (LIVE: whether it also does so when the upload fails after creating the
  // item). The VDF is regenerated from published.json on every run, so an
  // item created but not recorded would make the next run create a second one.
  const vdfId = readVdfPublishedFileId(fs.readFileSync(vdfPath, "utf8"));
  const workshopId = vdfId && /^\d+$/.test(vdfId) && vdfId !== "0" ? vdfId : null;
  const firstPublish = !doc.workshopId;
  const recordHint = (id) => `node scripts/workshop/publish.mjs record --id ${id} --visibility ${visibility}`;
  if (exitCode !== 0) {
    throw new PublishError(
      `steamcmd exited with code ${exitCode}; ${BRIDGE_FILES.published} is unchanged.` +
        (firstPublish && workshopId
          ? ` steamcmd did create Workshop item ${workshopId}. Record it before retrying, so the retry updates that item ` +
            `instead of creating another: ${recordHint(workshopId)}, then publish again with --force.`
          : ""),
    );
  }
  if (!workshopId) {
    throw new PublishError(
      firstPublish
        ? `steamcmd finished but didn't write the new item's id into ${vdfPath}; ${BRIDGE_FILES.published} is unchanged. ` +
          "It has probably created the Workshop item already, so don't publish again (that would create a second item). " +
          `Find the id in the steamcmd output above or under Workshop Items on the account's Steam profile, then run: ${recordHint("<id>")}`
        : `steamcmd finished but ${vdfPath} holds no Workshop item id; ${BRIDGE_FILES.published} is unchanged`,
    );
  }
  assertCanRecordId(doc, workshopId);
  writePublished(repoRoot, published.text, {
    workshopId,
    visibility,
    publishedVersion: status.version,
    publishedAt: now().toISOString(),
  });
  log(`Published PanelBridge ${status.version} as Workshop item ${workshopId} (${visibility}).`);
  // stdio stays attached to the terminal (steamcmd prompts there), so its
  // output can't be checked here, and on an update the VDF held this id
  // before steamcmd ran: exit code 0 is the only signal this tool gets.
  log(
    `steamcmd's exit code doesn't prove the upload worked. Before committing, check that the change note shows on ` +
      `https://steamcommunity.com/sharedfiles/filedetails/changelog/${workshopId}. If it doesn't, keep the recorded id ` +
      "and publish again with --force.",
  );
  if (status.changed) {
    // publishedVersion names VERSION either way (spec §8.9), so nothing
    // records that this upload wasn't a release, and release.ps1 compares
    // only versions: after a revert it would never ask for the publish.
    warn(
      `Workshop item ${workshopId} now holds unreleased code, but ${BRIDGE_FILES.published} records it as ` +
        `${status.version}, so release.ps1 won't ask you to publish again. Publish from the next tagged release even ` +
        `if these changes are reverted (with --force if that release keeps ${status.version}).`,
    );
  }
  log(commitAdvice(firstPublish));
  log(
    "If the tags are missing on the Steam page, set them once in the in-game uploader " +
      `(npm run workshop:build -- --out ~/Zomboid/Workshop), then move ${DEFAULT_STAGED_ITEM_DIR} out of ` +
      "~/Zomboid/Workshop: while it is there, this machine loads it instead of the downloaded Workshop item.",
  );
  return 0;
}

export async function runPublishCli(argv, deps = {}) {
  const {
    repoRoot = REPO_ROOT,
    env = process.env,
    spawn = nodeSpawn,
    now = () => new Date(),
    log = console.log,
    error = console.error,
  } = deps;
  const warn = (message) => error(`WARNING: ${message}`);
  try {
    const { mode, options } = parseArgs(argv);
    if (mode === "help") {
      log(USAGE);
      return 0;
    }
    const passwordVars = PASSWORD_ENV_VARS.filter((name) => env[name]);
    if (passwordVars.length) {
      throw new PublishError(
        `Unset ${passwordVars.join(", ")}: this tool never uses a Steam password, and steamcmd prompts for it itself.`,
      );
    }
    return mode === "record"
      ? await runRecord(options, { repoRoot, now, log, warn })
      : await runPublish(options, { repoRoot, spawn, now, log, warn });
  } catch (caught) {
    error(caught instanceof PublishError ? caught.message : `Workshop publish failed: ${caught.message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runPublishCli(process.argv.slice(2));
}
