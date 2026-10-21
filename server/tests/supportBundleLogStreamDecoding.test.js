import { describe, expect, it } from "vitest";
import { Readable } from "stream";
import { createRedactingLogStream } from "../routes/debug.js";

// The support bundle streams each raw log through createRedactingLogStream()
// in 64 KB chunks, which cut wherever they cut: through the bytes of one
// UTF-8 character too. Each chunk used to be decoded on its own, so that
// character became two U+FFFD, and a secret containing it no longer matched
// the exact-value redaction.

async function collectStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
}

const BOM = String.fromCharCode(0xfeff);

describe("createRedactingLogStream(): text split mid-character", () => {
  it("keeps a multi-byte character whose bytes straddle a chunk boundary", async () => {
    const bytes = Buffer.from("Joueur connecté: Zoë 🧟\n", "utf-8");
    const cut = bytes.indexOf(Buffer.from("é", "utf-8")) + 1; // inside "é"
    const zombie = bytes.indexOf(Buffer.from("🧟", "utf-8")) + 2; // inside the emoji
    const source = Readable.from([
      bytes.subarray(0, cut),
      bytes.subarray(cut, zombie),
      bytes.subarray(zombie),
    ]);
    const out = await collectStream(source.pipe(createRedactingLogStream(["hunter2"])));
    expect(out).toBe("Joueur connecté: Zoë 🧟\n");
  });

  it("redacts a non-ASCII secret whose bytes are split across chunks", async () => {
    const bytes = Buffer.from("rcon password=pässwörd ok\n", "utf-8");
    const cut = bytes.indexOf(Buffer.from("ö", "utf-8")) + 1;
    const source = Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]);
    const out = await collectStream(source.pipe(createRedactingLogStream(["pässwörd"])));
    expect(out).toBe("rcon password=[REDACTED] ok\n");
  });

  it("keeps a final line cut mid-character and a leading BOM", async () => {
    const bytes = Buffer.from(BOM + "last line é", "utf-8");
    const source = Readable.from([bytes.subarray(0, bytes.length - 1), bytes.subarray(bytes.length - 1)]);
    const out = await collectStream(source.pipe(createRedactingLogStream([])));
    expect(out).toBe(BOM + "last line é");
  });
});
