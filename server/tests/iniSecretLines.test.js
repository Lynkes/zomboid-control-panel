import { describe, expect, it } from "vitest";
import {
  keepLiveSecretIniLines,
  maskSensitiveIniLines,
  reconcileMaskedIniLines,
  stripSensitiveIniLines,
} from "../utils/iniSecretLines.js";
import * as serverFiles from "../routes/serverFiles.js";

// The three helpers moved here from routes/serverFiles.js unchanged, which
// still exports them; keepLiveSecretIniLines() is new and is what POST
// /templates/:id/apply puts between the saved template and the live .ini.

describe("the helpers moved out of routes/serverFiles.js are the same functions there", () => {
  it("re-exports them", () => {
    expect(serverFiles.stripSensitiveIniLines).toBe(stripSensitiveIniLines);
    expect(serverFiles.maskSensitiveIniLines).toBe(maskSensitiveIniLines);
    expect(serverFiles.reconcileMaskedIniLines).toBe(reconcileMaskedIniLines);
  });
});

describe("keepLiveSecretIniLines", () => {
  const live = [
    "PVP=true",
    "RCONPassword=live-rcon",
    "Password=live-join",
    "DiscordToken=live-token",
    "RCONPort=27015",
    "",
  ].join("\n");

  it("puts every live secret line back into a template saved without secrets, keeping the file's final line break", () => {
    const template = stripSensitiveIniLines(live.replace("PVP=true", "PVP=false"));
    expect(template).toBe("PVP=false\nRCONPort=27015\n");

    expect(keepLiveSecretIniLines(template, live)).toBe(
      "PVP=false\nRCONPort=27015\nRCONPassword=live-rcon\nPassword=live-join\nDiscordToken=live-token\n",
    );
  });

  it("uses the live value, not the template's, for a key both have (a template saved before secrets were left out)", () => {
    const template = "PVP=false\nRCONPassword=stale-rcon\nPassword=••••••••\n";

    expect(keepLiveSecretIniLines(template, live)).toBe(
      "PVP=false\nRCONPassword=live-rcon\nPassword=live-join\nDiscordToken=live-token\n",
    );
  });

  it("keeps a template's own secret line when the live file has no line for that key, but never the mask placeholder", () => {
    const template = "RCONPassword=from-template\nPassword=••••••••\nPVP=false\n";

    expect(keepLiveSecretIniLines(template, "PVP=true\n")).toBe(
      "RCONPassword=from-template\nPVP=false\n",
    );
  });

  it("leaves a template with nothing to merge byte for byte, whatever its line endings", () => {
    expect(keepLiveSecretIniLines("PVP=false\nDefaultPort=1\n", "PVP=true\n")).toBe(
      "PVP=false\nDefaultPort=1\n",
    );
    expect(keepLiveSecretIniLines("PVP=false\r\nDefaultPort=1\r\n", "")).toBe(
      "PVP=false\r\nDefaultPort=1\r\n",
    );
  });

  it("writes the live lines with the template's own line ending", () => {
    expect(keepLiveSecretIniLines("PVP=false\r\n", "RCONPassword=live-rcon\r\nPVP=true\r\n")).toBe(
      "PVP=false\r\nRCONPassword=live-rcon\r\n",
    );
  });

  it("copies the live line as written, spacing and dollar signs included", () => {
    expect(keepLiveSecretIniLines("PVP=false\n", "  RCONPassword=Pa$$w0rd;x\n")).toBe(
      "PVP=false\n  RCONPassword=Pa$$w0rd;x\n",
    );
  });

  it("keeps every live line of a repeated key, at the place of the template's first line for it", () => {
    expect(
      keepLiveSecretIniLines("A=1\nPassword=old\nB=2\nPassword=older\n", "Password=one\nPassword=two\n"),
    ).toBe("A=1\nPassword=one\nPassword=two\nB=2\n");
  });

  it("does not treat a comment, a blank line or a setting merely mentioning a secret as a secret line", () => {
    const template = "# RCONPassword=in a comment\n\nServerWelcomeMessage=\"RCONPassword=x\"\n";
    expect(keepLiveSecretIniLines(template, "# Password=live comment\nServerWelcomeMessage=\"a\"\n")).toBe(template);
  });

  it("handles an empty template and an empty live file", () => {
    expect(keepLiveSecretIniLines("", "RCONPassword=live\n")).toBe("RCONPassword=live\n");
    expect(keepLiveSecretIniLines("", "")).toBe("");
  });
});
