/**
 * hunt-wave6-2026-08-29 follow-up 1 (RCON success-branch leak): discordBot.js's
 * handleRcon() posts a command's raw response to Discord with no secret-aware
 * sanitization — only the pre-existing sourceRcon.js timeout-message tracing
 * showed that failure-path leaks were (coincidentally) neutralized; nothing
 * protects a SUCCESS response that happens to echo a secret. god's ruling,
 * verbatim reasoning kept here because it explains every choice below:
 *
 *   - NOT a shape heuristic ("looks like a password"). A heuristic that
 *     guesses what a secret looks like is a new bug: it over-matches
 *     ordinary output and under-matches a real secret that doesn't look
 *     like one, either way giving false assurance.
 *   - NOT pinned to which PZ command produced the string, or to today's
 *     PZ build. "Only 1 of 44 commands is a plausible leak vector today"
 *     is a property of THIS build, not something this codebase controls —
 *     a defence pinned to someone else's release notes is not a defence.
 *   - Instead: redact the secret VALUES the panel already holds, by EXACT
 *     match. No guessing, no false positives on unrelated text, and it
 *     doesn't care which command (or a 45th one added tomorrow) produced
 *     the string.
 *   - Applied at the boundary where messages LEAVE for Discord (see
 *     discordBot.js's _safeDiscordMakeRequest), not inside handleRcon()
 *     or any other individual caller — the same "guard the exit, not each
 *     caller" reasoning as Kevin's startServer() funnel fix the same day.
 *     This covers the success branch, the failure branch, and every
 *     future sender nobody has written yet.
 *
 * Precedent in this repo: server/utils/serverRconSecrets.js's
 * redactRconSecretsForWrite() and (structurally identical) the
 * panelBridgeSftpPassword handling already redact-before-persistence at the
 * db.json write boundary, by FIELD NAME on a structured object. This module
 * is the free-text analogue for a different boundary (the Discord publish
 * path) that had no equivalent — exact-value replacement instead of
 * field-name omission, because there is no schema to a Discord message.
 */

import { getServers, getSetting } from "../database/init.js";
import { readUiSecretFile } from "./uiSecretFile.js";
import { readIniValues } from "./templateFiles.js";
import fs from "fs";
import path from "path";

const REDACTED_PLACEHOLDER = "[REDACTED]";

// Per-server join Password (server.ini's Password= line) read LIVE off disk
// at collection time, not from any cached/stored value — closes the corner
// where an operator edited the .ini directly and the panel never separately
// recorded that value anywhere else. Best-effort: any resolution failure
// (missing path, missing file, unreadable) just means one fewer value to
// redact, never an error surfaced to the caller.
function readServerJoinPassword(server) {
  try {
    const serverName = server?.serverName;
    const configPath =
      server?.serverConfigPath ||
      (server?.zomboidDataPath ? path.join(server.zomboidDataPath, "Server") : null);
    if (
      !configPath ||
      !serverName ||
      typeof serverName !== "string" ||
      path.basename(serverName) !== serverName ||
      serverName.includes("..")
    ) {
      return null;
    }
    const iniPath = path.join(configPath, `${serverName}.ini`);
    if (!fs.existsSync(iniPath)) return null;
    const content = fs.readFileSync(iniPath, "utf8");
    const value = readIniValues(content, ["Password"]).Password;
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Every secret VALUE the panel currently holds, across every server
 * profile, not just the active one — an RCON command's response isn't
 * necessarily about the active server, and the whole point is not to guess.
 * Best-effort throughout: any single lookup failing (a deleted server
 * profile's secret file, a server.ini that moved) never aborts the rest.
 *
 * Returns a plain array of non-empty strings. Deliberately no minimum
 * length or "too common a word" exemption — see the module header. An
 * operator's own weak password choice (e.g. literally "admin") is still a
 * real secret, and this module's whole premise is that over-redacting a
 * published message is strictly safer than leaking one, even if the
 * output reads oddly for that one case.
 */
export async function collectKnownSecretValues() {
  const values = new Set();

  try {
    const servers = await getServers();
    for (const server of servers) {
      if (server?.rconPassword) values.add(String(server.rconPassword));
      const joinPassword = readServerJoinPassword(server);
      if (joinPassword) values.add(joinPassword);
    }
  } catch {
    /* best-effort: a database read failure here must not block sending */
  }

  try {
    const legacyRconPassword = await getSetting("rconPassword");
    if (legacyRconPassword) values.add(String(legacyRconPassword));
  } catch {
    /* best-effort */
  }

  for (const secretFileName of [
    "discordBotToken",
    "panelBridgeSftpPassword",
    "steamSessionId",
    "steamLoginSecure",
  ]) {
    try {
      const value = readUiSecretFile(secretFileName);
      if (value) values.add(value);
    } catch {
      /* best-effort */
    }
  }

  values.delete("");
  return [...values];
}

/**
 * Replaces every exact occurrence of any secret value with a fixed
 * placeholder. Matches both the secret's raw form and its JSON-string-
 * escaped form (a quote/backslash/newline inside a password would
 * otherwise survive JSON.stringify() as `\"`/`\\`/`\n` and no longer
 * byte-match the raw value) — this function is applied to the
 * ALREADY-SERIALIZED request body text, not a pre-serialization object, so
 * both forms can legitimately appear.
 *
 * MUST NOT be changed to log, throw with, or otherwise construct any
 * string containing a matched secret — this function is the one place in
 * the whole path guaranteed to be holding the plaintext value.
 */
export function redactKnownSecrets(text, secretValues) {
  if (typeof text !== "string" || !text || !secretValues?.length) return text;
  let result = text;
  for (const secret of secretValues) {
    if (!secret) continue;
    let escaped;
    try {
      escaped = JSON.stringify(secret).slice(1, -1);
    } catch {
      escaped = null;
    }
    if (escaped && escaped !== secret) {
      result = result.split(escaped).join(REDACTED_PLACEHOLDER);
    }
    result = result.split(secret).join(REDACTED_PLACEHOLDER);
  }
  return result;
}
