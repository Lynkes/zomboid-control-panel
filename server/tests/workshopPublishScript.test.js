import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PASSWORD_ENV_VARS,
  changeNoteFromLua,
  escapeVdf,
  readVdfPublishedFileId,
  renderItemVdf,
  runPublishCli,
  toVdfPath,
} from "../../scripts/workshop/publish.mjs";
import { writeBridgeVersionLock } from "../../scripts/check-bridge-version.mjs";
import { BRIDGE_FILES, REPO_ROOT, readRepoText } from "../../scripts/workshop/lib.mjs";

// scripts/workshop/publish.mjs (spec §8.9). steamcmd is never run here: the
// spawn is injected. The properties that matter most: no password ever passes
// through the tool, a pinned Workshop id is never replaced, and nothing is
// published that the release lock doesn't describe unless explicitly allowed.

const tempDirs = [];
const REAL_MOD_INFO = readRepoText(REPO_ROOT, BRIDGE_FILES.modInfo);
const VERSION = /^modversion=(.+)$/m.exec(REAL_MOD_INFO)[1];
// published.json as the contract commit created it (spec §5.2). Never the
// repository's copy: publishing and the live test fill that one in, and these
// tests must not start failing the day it is committed.
const CONTRACT_PUBLISHED = `{
  "schema": 1,
  "modId": "ZCPB",
  "workshopId": null,
  "visibility": null,
  "publishedVersion": null,
  "publishedAt": null,
  "liveVerified": { "windowsServer": null, "linuxServer": null }
}
`;
const NOW = new Date("2026-09-27T12:00:00.000Z");

function serverLua(extra = "") {
  return [
    "--[[",
    "    PanelBridge - Server-side mod for Zomboid Control Panel",
    `    Version: ${VERSION}`,
    "",
    "                vNEXT Changes:",
    "                - Add: delivery reporting.",
    "",
    `                v${VERSION} Changes:`,
    "                - Add: lightweight save-backed player leaderboard",
    "                    telemetry.",
    "",
    "                v1.7.67 Changes:",
    "                - Packaging: align versions.",
    "]]",
    "if not (isServer and isServer()) then return end",
    "local PanelBridge = {",
    `    VERSION = "${VERSION}",`,
    "    MOD_ID = \"ZCPB\",",
    "}",
    extra,
    "return PanelBridge",
    "",
  ].join("\n");
}

function makeRepo({ published = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workshop-publish-"));
  tempDirs.push(root);
  const write = (relativePath, content) => {
    const full = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write(BRIDGE_FILES.serverLua, serverLua());
  write(BRIDGE_FILES.clientLua, "if not (isClient and isClient()) then return end\n");
  write(BRIDGE_FILES.modInfo, REAL_MOD_INFO);
  for (const file of [BRIDGE_FILES.workshopTxt, BRIDGE_FILES.preview, BRIDGE_FILES.poster, BRIDGE_FILES.icon]) {
    write(file, fs.readFileSync(path.join(REPO_ROOT, file)));
  }
  let publishedText = CONTRACT_PUBLISHED;
  for (const [key, value] of Object.entries(published)) {
    publishedText = publishedText.replace(new RegExp(`("${key}": )null`), `$1${JSON.stringify(value)}`);
  }
  write(BRIDGE_FILES.published, publishedText);
  writeBridgeVersionLock(root, VERSION);
  const readPublishedText = () => fs.readFileSync(path.join(root, BRIDGE_FILES.published), "utf8");
  return { root, write, readPublishedText, readPublished: () => JSON.parse(readPublishedText()) };
}

// Stands in for steamcmd: records the call, then does what steamcmd does on
// success (writes the new item id back into the VDF) and exits.
function fakeSteamcmd({ writeId = "3712345678", exitCode = 0 } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options, vdf: fs.readFileSync(args[3], "utf8") });
    const child = new EventEmitter();
    setImmediate(() => {
      if (exitCode === 0 && writeId) {
        const vdf = fs.readFileSync(args[3], "utf8").replace(/("publishedfileid"\s+)"\d+"/, `$1"${writeId}"`);
        fs.writeFileSync(args[3], vdf);
      }
      child.emit("close", exitCode);
    });
    return child;
  };
  return { spawn, calls };
}

async function run(repo, argv, { spawn = fakeSteamcmd().spawn, env = {} } = {}) {
  const out = [];
  const err = [];
  const code = await runPublishCli(argv, {
    repoRoot: repo.root,
    env,
    spawn,
    now: () => NOW,
    log: (line) => out.push(String(line)),
    error: (line) => err.push(String(line)),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("workshop publish: credentials", () => {
  it("offers no password option in --help", async () => {
    const result = await run(makeRepo(), ["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/--steam-user <account>/);
    expect(result.out).not.toMatch(/--pass|-p\b|STEAM_PASSWORD/);
    expect(result.out).toMatch(/steamcmd asks for\s+its password and Steam Guard code itself/);
  });

  it.each([["--password", "hunter2"], ["--password=hunter2"], ["-p", "hunter2"], ["--pass", "x"], ["--steam-password", "x"]])(
    "refuses %s without running steamcmd",
    async (...args) => {
      const steamcmd = fakeSteamcmd();
      const result = await run(makeRepo(), ["--steam-user", "maint", ...args.filter(Boolean)], { spawn: steamcmd.spawn });
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/never takes a Steam password/);
      expect(steamcmd.calls).toHaveLength(0);
    },
  );

  it.each(PASSWORD_ENV_VARS)("refuses to run while %s is set", async (name) => {
    const steamcmd = fakeSteamcmd();
    const result = await run(makeRepo(), ["--steam-user", "maint"], { spawn: steamcmd.spawn, env: { [name]: "secret" } });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(new RegExp(`Unset ${name}`));
    expect(result.err).not.toMatch(/secret/);
    expect(steamcmd.calls).toHaveLength(0);
  });

  it("refuses a --steam-user that could smuggle a second argument", async () => {
    const result = await run(makeRepo(), ["--steam-user", "maint hunter2", "--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/must be a Steam account name/);
  });

  it.each([
    [["--steam-user", "maint", "hunter2", "--dry-run"]],
    [["--steam-user", "maint", "-hunter2$", "--dry-run"]],
    // Shaped like an option: only names this tool defines are echoed.
    [["--steam-user", "maint", "-Hunter2", "--dry-run"]],
    [["--steam-user", "maint", "--hunter2", "--dry-run"]],
    [["--steam-user", "maint", "--hunter=2", "--dry-run"]],
    [["record", "--id", "1", "hunter2"]],
  ])("never echoes a stray value that may be a password: %j", async (argv) => {
    const steamcmd = fakeSteamcmd();
    const result = await run(makeRepo(), argv, { spawn: steamcmd.spawn });
    expect(result.code).toBe(1);
    expect(`${result.out}\n${result.err}`).not.toMatch(/hunter/i);
    expect(result.err).toMatch(/Unknown argument for (publish|record) \(not shown, in case it's a password\)\. This tool never takes a password/);
    expect(steamcmd.calls).toHaveLength(0);
  });

  it("names an option of the other mode, but not its inline value", async () => {
    const result = await run(makeRepo(), ["--steam-user", "maint", "--id=secret", "--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/Unknown argument for publish: --id\n/);
    expect(result.err).not.toMatch(/secret/);
  });

  it("runs steamcmd attached to the terminal so it prompts for the secrets itself", async () => {
    const repo = makeRepo();
    const steamcmd = fakeSteamcmd();
    const result = await run(repo, ["--steam-user", "maint", "--steamcmd", "C:/steamcmd/steamcmd.exe"], { spawn: steamcmd.spawn });
    expect(result.code).toBe(0);
    expect(steamcmd.calls).toHaveLength(1);
    const [call] = steamcmd.calls;
    expect(call.command).toBe("C:/steamcmd/steamcmd.exe");
    expect(call.args).toEqual(["+login", "maint", "+workshop_build_item", path.join(repo.root, "dist-workshop", "item.vdf"), "+quit"]);
    expect(call.options).toEqual({ stdio: "inherit" });
    expect(result.out).toMatch(/Workshop items can't be transferred to another account later/);
    expect(result.out).toMatch(/use its logout command on shared machines/);
  });
});

describe("workshop publish: the item.vdf", () => {
  const vdfFields = {
    workshopId: null,
    contentFolder: "C:/dist/Contents",
    previewFile: "/srv/dist/preview.png",
    visibility: "unlisted",
    title: "Zomboid Control Panel Bridge",
    description: "line 1\nline 2",
    changenote: "Fix: \"Stop All Weather\" left snow on",
  };

  it("escapes backslashes and quotes", () => {
    expect(escapeVdf("C:\\a \"b\"")).toBe("C:\\\\a \\\"b\\\"");
  });

  // Whether steamcmd honours \" and \\ in item.vdf is unknown, so the values
  // never carry either: the file then reads the same with or without escapes.
  it("writes values with no quote or backslash, so steamcmd reads them the same either way", () => {
    const vdf = renderItemVdf(vdfFields);
    expect(vdf).toBe([
      "\"workshopitem\"",
      "{",
      "  \"appid\"           \"108600\"",
      "  \"publishedfileid\" \"0\"",
      "  \"contentfolder\"   \"C:/dist/Contents\"",
      "  \"previewfile\"     \"/srv/dist/preview.png\"",
      "  \"visibility\"      \"3\"",
      "  \"title\"           \"Zomboid Control Panel Bridge\"",
      "  \"description\"     \"line 1\nline 2\"",
      "  \"changenote\"      \"Fix: 'Stop All Weather' left snow on\"",
      "}",
      "",
    ].join("\n"));
    expect(readVdfPublishedFileId(vdf)).toBe("0");
    expect(renderItemVdf({ ...vdfFields, title: "Say \"hi\"" })).toMatch(/"title"\s+"Say 'hi'"/);
  });

  it("refuses a backslash in the text and a path that wasn't converted", () => {
    expect(() => renderItemVdf({ ...vdfFields, changenote: "Fix: json.decode dropped \\uXXXX escapes" }))
      .toThrow(/changenote contains a backslash.*--changenote-file/);
    expect(() => renderItemVdf({ ...vdfFields, description: "a\\b" })).toThrow(/description contains a backslash/);
    expect(() => renderItemVdf({ ...vdfFields, contentFolder: "C:\\dist\\Contents" })).toThrow(/contentfolder contains a quote or backslash/);
  });

  it("writes Windows paths with forward slashes and refuses a path it can't carry", () => {
    expect(toVdfPath("C:\\Users\\maint\\dist-workshop\\Contents", "\\")).toBe("C:/Users/maint/dist-workshop/Contents");
    expect(toVdfPath("/home/maint/dist-workshop/Contents", "/")).toBe("/home/maint/dist-workshop/Contents");
    expect(() => toVdfPath("/home/ma\\int/Contents", "/")).toThrow(/can't carry reliably/);
    expect(() => toVdfPath("/home/\"maint\"/Contents", "/")).toThrow(/can't carry reliably/);
  });

  it("--dry-run prints the VDF with absolute paths and runs and writes nothing", async () => {
    const repo = makeRepo();
    const steamcmd = fakeSteamcmd();
    const before = repo.readPublishedText();
    const result = await run(repo, ["--steam-user", "maint", "--dry-run"], { spawn: steamcmd.spawn });
    expect(result.code).toBe(0);
    expect(steamcmd.calls).toHaveLength(0);
    expect(fs.existsSync(path.join(repo.root, "dist-workshop"))).toBe(false);
    expect(repo.readPublishedText()).toBe(before);

    const vdf = result.out.slice(result.out.indexOf("\"workshopitem\""), result.out.indexOf("}") + 1);
    expect(vdf).not.toMatch(/\\/);
    const folder = /"contentfolder"\s+"([^"]+)"/.exec(vdf)[1];
    const preview = /"previewfile"\s+"([^"]+)"/.exec(vdf)[1];
    const forward = (filePath) => filePath.split(path.sep).join("/");
    expect(path.isAbsolute(folder)).toBe(true);
    expect(folder).toBe(forward(path.join(repo.root, "dist-workshop", "ZCPB", "Contents")));
    expect(preview).toBe(forward(path.join(repo.root, "dist-workshop", "ZCPB", "preview.png")));
    expect(result.out).toMatch(/"appid"\s+"108600"/);
    expect(result.out).toMatch(/"publishedfileid"\s+"0"/);
    expect(result.out).toMatch(/"title"\s+"Zomboid Control Panel Bridge"/);
    expect(result.out).toMatch(/Would run: steamcmd \+login maint \+workshop_build_item .*item\.vdf \+quit/);
  });

  it.each([
    [[], "3"],
    [["--visibility", "unlisted"], "3"],
    [["--visibility", "public"], "0"],
  ])("maps visibility %j to %s", async (extra, code) => {
    const result = await run(makeRepo(), ["--steam-user", "maint", "--dry-run", ...extra]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(new RegExp(`"visibility"\\s+"${code}"`));
  });

  it("takes the default visibility from published.json", async () => {
    const result = await run(makeRepo({ published: { visibility: "public" } }), ["--steam-user", "maint", "--dry-run"]);
    expect(result.out).toMatch(/"visibility"\s+"0"/);
  });

  it.each(["private", "friendsOnly"])("refuses %s visibility (dedicated servers download anonymously)", async (visibility) => {
    const result = await run(makeRepo(), ["--steam-user", "maint", "--dry-run", "--visibility", visibility]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/must be public or unlisted/);
  });

  it("uses --changenote-file when given", async () => {
    const repo = makeRepo();
    repo.write("note.txt", "Fixes the \"Stop All Weather\" thing.\r\n");
    const result = await run(repo, ["--steam-user", "maint", "--dry-run", "--changenote-file", path.join(repo.root, "note.txt")]);
    expect(result.out).toMatch(/"changenote"\s+"Fixes the 'Stop All Weather' thing\."/);

    repo.write("note.txt", "Handles C:\\ paths.\n");
    const refused = await run(repo, ["--steam-user", "maint", "--dry-run", "--changenote-file", path.join(repo.root, "note.txt")]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/changenote contains a backslash/);
    expect(refused.out).not.toMatch(/workshopitem/);
  });
});

describe("workshop publish: recording the id", () => {
  it("records the id steamcmd writes back on a first publish", async () => {
    const repo = makeRepo();
    const steamcmd = fakeSteamcmd({ writeId: "3712345678" });
    const result = await run(repo, ["--steam-user", "maint"], { spawn: steamcmd.spawn });
    expect(result.code).toBe(0);
    expect(steamcmd.calls[0].vdf).toMatch(/"publishedfileid"\s+"0"/);
    expect(repo.readPublished()).toEqual({
      ...JSON.parse(CONTRACT_PUBLISHED),
      workshopId: "3712345678",
      visibility: "unlisted",
      publishedVersion: VERSION,
      publishedAt: NOW.toISOString(),
    });
    // Only the four fields moved; the hand-maintained liveVerified line didn't reflow.
    expect(repo.readPublishedText()).toMatch(/^ {2}"liveVerified": \{ "windowsServer": null, "linuxServer": null \}$/m);
    // A push to main republishes the aio Docker image, so a new item's id
    // waits for the live test.
    expect(result.out).toMatch(
      /Don't commit pz-mod\/workshop\/published\.json to main until the live test has passed with it: .*aio Docker image.*Keep it on a branch until then\./,
    );
    expect(result.out).not.toMatch(/^Commit /m);
    // Setting the tags in-game stages a copy that then shadows the download.
    expect(result.out).toMatch(
      /set them once in the in-game uploader \(npm run workshop:build -- --out ~\/Zomboid\/Workshop\), then move ~\/Zomboid\/Workshop\/ZCPB out of ~\/Zomboid\/Workshop: while it is there, this machine loads it instead of the downloaded Workshop item\./,
    );
    // Exit code 0 is all steamcmd reports back, so the maintainer is sent to check.
    expect(result.out).toMatch(
      /exit code doesn't prove the upload worked\. .*sharedfiles\/filedetails\/changelog\/3712345678\. .*publish again with --force/,
    );
    // The item was built for steamcmd to upload.
    expect(fs.existsSync(path.join(repo.root, "dist-workshop", "ZCPB", "Contents", "mods"))).toBe(true);
  });

  it("updates an existing item under its pinned id", async () => {
    const repo = makeRepo({ published: { workshopId: "3712345678", publishedVersion: "1.7.1" } });
    const steamcmd = fakeSteamcmd({ writeId: "3712345678" });
    const result = await run(repo, ["--steam-user", "maint"], { spawn: steamcmd.spawn });
    expect(result.code).toBe(0);
    expect(steamcmd.calls[0].vdf).toMatch(/"publishedfileid"\s+"3712345678"/);
    expect(repo.readPublished()).toMatchObject({ workshopId: "3712345678", publishedVersion: VERSION });
    expect(result.out).toMatch(/^Commit pz-mod\/workshop\/published\.json\.$/m);
    expect(result.err).toBe("");
  });

  it("refuses to replace a pinned id with a different one", async () => {
    const repo = makeRepo({ published: { workshopId: "111", publishedVersion: "1.7.1" } });
    const before = repo.readPublishedText();
    const result = await run(repo, ["--steam-user", "maint"], { spawn: fakeSteamcmd({ writeId: "222" }).spawn });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/already pins Workshop item 111; refusing to replace it with 222/);
    expect(repo.readPublishedText()).toBe(before);
  });

  it("leaves published.json alone when steamcmd fails or returns no id", async () => {
    const repo = makeRepo();
    const before = repo.readPublishedText();
    const failed = await run(repo, ["--steam-user", "maint"], { spawn: fakeSteamcmd({ exitCode: 5 }).spawn });
    expect(failed.code).toBe(1);
    expect(failed.err).toMatch(/steamcmd exited with code 5; pz-mod\/workshop\/published\.json is unchanged\.$/);
    const noId = await run(repo, ["--steam-user", "maint"], { spawn: fakeSteamcmd({ writeId: null }).spawn });
    expect(noId.code).toBe(1);
    expect(noId.err).toMatch(/didn't write the new item's id/);
    expect(repo.readPublishedText()).toBe(before);
  });

  it("on a first publish with no id back, warns that the item probably exists and says how to record it", async () => {
    const repo = makeRepo();
    const result = await run(repo, ["--steam-user", "maint", "--visibility", "public"], {
      spawn: fakeSteamcmd({ writeId: null }).spawn,
    });
    expect(result.code).toBe(1);
    // A rerun regenerates the VDF with publishedfileid 0 and would create a second item.
    expect(result.err).toMatch(/probably created the Workshop item already, so don't publish again/);
    expect(result.err).toMatch(/node scripts\/workshop\/publish\.mjs record --id <id> --visibility public$/);
  });

  it("when steamcmd fails after creating the item, says to record it before retrying", async () => {
    const repo = makeRepo();
    const before = repo.readPublishedText();
    const steamcmd = fakeSteamcmd({ exitCode: 7 });
    // steamcmd created the item and wrote its id back, then failed the upload.
    const spawn = (command, args, options) => {
      fs.writeFileSync(args[3], fs.readFileSync(args[3], "utf8").replace(/("publishedfileid"\s+)"0"/, "$1\"3712345678\""));
      return steamcmd.spawn(command, args, options);
    };
    const result = await run(repo, ["--steam-user", "maint"], { spawn });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/steamcmd exited with code 7; .* is unchanged\. steamcmd did create Workshop item 3712345678\./);
    expect(result.err).toMatch(/record --id 3712345678 --visibility unlisted, then publish again with --force\.$/);
    expect(repo.readPublishedText()).toBe(before);
  });

  it("keeps the plain error when an update's steamcmd run fails", async () => {
    const repo = makeRepo({ published: { workshopId: "3712345678", publishedVersion: "1.7.1" } });
    const result = await run(repo, ["--steam-user", "maint"], { spawn: fakeSteamcmd({ exitCode: 5 }).spawn });
    expect(result.code).toBe(1);
    expect(result.err).toBe("steamcmd exited with code 5; pz-mod/workshop/published.json is unchanged.");
  });

  it("record --id writes the same fields as a publish", async () => {
    const repo = makeRepo();
    const result = await run(repo, ["record", "--id", "3712345678", "--visibility", "unlisted"]);
    expect(result.code).toBe(0);
    expect(repo.readPublished()).toMatchObject({
      workshopId: "3712345678",
      visibility: "unlisted",
      publishedVersion: VERSION,
      publishedAt: NOW.toISOString(),
    });
    // --id is also the fallback after steamcmd, so the staged-copy warning is conditional.
    expect(result.err).toBe(
      "WARNING: If you uploaded it with the in-game uploader, ~/Zomboid/Workshop/ZCPB is still in " +
        "the game's Workshop folder. Move it out of ~/Zomboid/Workshop before you test on this machine: while it is " +
        "there, the game and any Steam-mode server that uses this Zomboid folder load that staged copy instead of the " +
        "downloaded Workshop item, so the live test would check the wrong files, and after the next publish they would " +
        "silently keep running this old code. To upload it in-game again, recreate it with its id: " +
        "npm run workshop:build -- --out \"~/Zomboid/Workshop\"",
    );
  });

  // ZomboidFileSystem.getAllModFolders (42.20) lists staged items ahead of
  // the Workshop downloads and the first folder with a mod id wins, so the
  // uploaded copy left in <Zomboid>/Workshop replaces the downloaded item on
  // this machine: the live test would run it, and later publishes never load.
  it("record --from-staged reads id= and visibility= from the staged workshop.txt, then says to move the staged copy out", async () => {
    const repo = makeRepo();
    const workshop = path.join(repo.root, "Workshop");
    const staged = path.join(workshop, "ZCPB");
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, "workshop.txt"), "version=1\r\nid=3712345678\r\ntitle=Zomboid Control Panel Bridge\r\nvisibility=public\r\n");
    const result = await run(repo, ["record", "--from-staged", staged]);
    expect(result.code).toBe(0);
    expect(repo.readPublished()).toMatchObject({ workshopId: "3712345678", visibility: "public" });
    expect(result.err).toBe(
      `WARNING: ${staged} is still in the game's Workshop folder. Move it out of ${workshop} before you test on this ` +
        "machine: while it is there, the game and any Steam-mode server that uses this Zomboid folder load that staged " +
        "copy instead of the downloaded Workshop item, so the live test would check the wrong files, and after the next " +
        "publish they would silently keep running this old code. To upload it in-game again, recreate it with its id: " +
        `npm run workshop:build -- --out "${workshop}"`,
    );
    // A new item's id reaches the aio Docker image as soon as it is on main.
    expect(result.out).toMatch(/Don't commit pz-mod\/workshop\/published\.json to main until the live test has passed with it/);

    // The same id again (a later in-game upload): committing straight away is fine.
    const again = await run(repo, ["record", "--from-staged", staged]);
    expect(again.code).toBe(0);
    expect(again.err).toMatch(/is still in the game's Workshop folder\. Move it out/);
    expect(again.out).toMatch(/^Commit pz-mod\/workshop\/published\.json\.$/m);
  });

  it("record --from-staged outside a Workshop folder gives the conditional warning", async () => {
    const repo = makeRepo();
    const copy = path.join(repo.root, "copy-of-item");
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, "workshop.txt"), "version=1\nid=3712345678\ntitle=x\n");
    const result = await run(repo, ["record", "--from-staged", copy]);
    expect(result.code).toBe(0);
    expect(result.err).toMatch(/^WARNING: If you uploaded it with the in-game uploader, ~\/Zomboid\/Workshop\/ZCPB is still/);
  });

  it("record refuses a staged item without an id, a bad id, a changed id and ambiguous input", async () => {
    const repo = makeRepo();
    const staged = path.join(repo.root, "Workshop", "ZCPB");
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, "workshop.txt"), "version=1\ntitle=x\n");
    expect((await run(repo, ["record", "--from-staged", staged])).err).toMatch(/has no id= line yet/);
    expect((await run(repo, ["record", "--id", "0"])).err).toMatch(/isn't a Workshop item id/);
    expect((await run(repo, ["record", "--id", "12a"])).err).toMatch(/isn't a Workshop item id/);
    expect((await run(repo, ["record"])).err).toMatch(/exactly one of --from-staged/);
    expect((await run(repo, ["record", "--id", "1", "--from-staged", staged])).err).toMatch(/exactly one of --from-staged/);
    expect((await run(repo, ["record", "--id", "1", "--steam-user", "x"])).err).toMatch(/Unknown argument for record: --steam-user/);

    const pinned = makeRepo({ published: { workshopId: "111" } });
    const before = pinned.readPublishedText();
    expect((await run(pinned, ["record", "--id", "222"])).err).toMatch(/refusing to replace it with 222/);
    expect(pinned.readPublishedText()).toBe(before);
  });
});

describe("workshop publish: preconditions", () => {
  it("refuses to republish the published version without --force", async () => {
    const repo = makeRepo({ published: { workshopId: "3712345678", publishedVersion: VERSION } });
    const steamcmd = fakeSteamcmd();
    const refused = await run(repo, ["--steam-user", "maint"], { spawn: steamcmd.spawn });
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(new RegExp(`PanelBridge ${VERSION.replace(/\./g, "\\.")} is already published`));
    expect(steamcmd.calls).toHaveLength(0);
    const forced = await run(repo, ["--steam-user", "maint", "--force"], { spawn: steamcmd.spawn });
    expect(forced.code).toBe(0);
    expect(steamcmd.calls).toHaveLength(1);
  });

  it("--dry-run still prints the VDF when a real run would refuse, then fails with the reasons", async () => {
    const repo = makeRepo({ published: { workshopId: "3712345678", publishedVersion: VERSION } });
    repo.write(BRIDGE_FILES.serverLua, serverLua("-- an unreleased change"));
    const steamcmd = fakeSteamcmd();
    const before = repo.readPublishedText();
    const result = await run(repo, ["--steam-user", "maint", "--dry-run"], { spawn: steamcmd.spawn });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/"publishedfileid"\s+"3712345678"/);
    expect(result.out).toMatch(/Would run: steamcmd \+login maint/);
    expect(result.err).toMatch(/^A real run would refuse:\nPanelBridge code differs from the released .*\nPanelBridge .* is already published/);
    expect(steamcmd.calls).toHaveLength(0);
    expect(fs.existsSync(path.join(repo.root, "dist-workshop"))).toBe(false);
    expect(repo.readPublishedText()).toBe(before);

    const allowed = await run(repo, ["--steam-user", "maint", "--dry-run", "--allow-unreleased", "--force"]);
    expect(allowed.code).toBe(0);
    expect(allowed.err).toMatch(/WARNING: Publishing UNRELEASED PanelBridge code/);
  });

  it("refuses code the release lock doesn't describe unless --allow-unreleased", async () => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.serverLua, serverLua("-- an unreleased change"));
    const steamcmd = fakeSteamcmd();
    const refused = await run(repo, ["--steam-user", "maint"], { spawn: steamcmd.spawn });
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/differs from the released .* --allow-unreleased/);
    expect(steamcmd.calls).toHaveLength(0);
    const allowed = await run(repo, ["--steam-user", "maint", "--allow-unreleased"], { spawn: steamcmd.spawn });
    expect(allowed.code).toBe(0);
    expect(allowed.err).toMatch(/WARNING: Publishing UNRELEASED PanelBridge code/);
    expect(steamcmd.calls).toHaveLength(1);
    // publishedVersion still names the released VERSION, so release.ps1 can't
    // tell; after a revert nothing else would ask for the publish.
    expect(repo.readPublished().publishedVersion).toBe(VERSION);
    expect(allowed.err).toMatch(
      new RegExp(
        "WARNING: Workshop item 3712345678 now holds unreleased code, but pz-mod/workshop/published\\.json records it as " +
          `${VERSION.replace(/\./g, "\\.")}, so release\\.ps1 won't ask you to publish again\\. Publish from the next tagged ` +
          "release even if these changes are reverted \\(with --force if that release keeps",
      ),
    );
  });

  it("refuses when the item fails its build checks", async () => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.clientLua, "print('no guard')\n");
    const steamcmd = fakeSteamcmd();
    const result = await run(repo, ["--steam-user", "maint", "--dry-run"], { spawn: steamcmd.spawn });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/Workshop item check failed/);
    expect(steamcmd.calls).toHaveLength(0);
  });

  it("refuses when the mod id in published.json changed", async () => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.published, CONTRACT_PUBLISHED.replace("\"ZCPB\"", "\"PanelBridge\""));
    const result = await run(repo, ["--steam-user", "maint", "--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/modId must be ZCPB/);
  });
});

describe("workshop publish: change notes from the Lua header", () => {
  const lua = serverLua();

  it("uses the current block (and vNEXT) on a first publish, not the whole history", () => {
    // vNEXT only reaches a change note in an --allow-unreleased publish, where
    // VERSION still names the last release: it must not get a second
    // "v<VERSION> Changes:" heading.
    expect(changeNoteFromLua(lua, { version: VERSION, publishedVersion: null })).toBe([
      "Unreleased changes:",
      "- Add: delivery reporting.",
      "",
      `v${VERSION} Changes:`,
      "- Add: lightweight save-backed player leaderboard telemetry.",
    ].join("\n"));
    expect(changeNoteFromLua(lua, { version: VERSION, publishedVersion: VERSION })).toBe(
      "Unreleased changes:\n- Add: delivery reporting.",
    );
  });

  it("uses every block newer than the last published version", () => {
    const note = changeNoteFromLua(lua, { version: VERSION, publishedVersion: "1.7.60" });
    expect(note).toMatch(/v1\.7\.67 Changes:\n- Packaging: align versions\./);
    expect(changeNoteFromLua(lua, { version: VERSION, publishedVersion: "1.7.67" })).not.toMatch(/1\.7\.67/);
  });

  it("falls back to the version when the header has no matching block", () => {
    expect(changeNoteFromLua("--[[\n    Version: 2.0.0\n]]\n", { version: "2.0.0", publishedVersion: null })).toBe("PanelBridge 2.0.0");
  });
});
