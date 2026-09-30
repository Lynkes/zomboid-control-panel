// Run by fileManagerZip.test.js in a plain `node` child, not inside vitest:
// the race below depends on the exact order in which a stream's async
// iteration, zlib and the socket's events interleave, and under vitest's
// module transform it never showed (0 of 20 attempts hung, against about half
// of them in plain node before the fix).
//
// A StreamingZipWriter writes into a real HTTP response while a client reads
// 64 KiB of it and goes away. Once the client's FIN arrives, http ends the
// socket, and a res.write() made before the socket has finished closing is
// parked in the response's own buffer: http never calls that write's
// callback, and a response that closes emits no 'error'. A source that
// yields between chunks (an SFTP read; setImmediate here) keeps landing
// writes in that window.
//
// Usage: node zipClientGoneChild.mjs <tempDir> [attempts]
// Prints one JSON line: { attempts, outcomes, sourcesLeftOpen, tempFilesLeft }.
import crypto from "crypto";
import fs from "fs";
import http from "http";
import { Readable } from "stream";
import { StreamingZipWriter } from "../../utils/streamingZip.js";

const tempDir = process.argv[2];
const attempts = Number(process.argv[3]) || 12;
const pool = crypto.randomBytes(1024 * 1024);

function yieldingSource(total = 64 * 1024 * 1024) {
  let sent = 0;
  return new Readable({
    highWaterMark: 64 * 1024,
    read() {
      if (sent >= total) return this.push(null);
      setImmediate(() => {
        const n = Math.min(32 * 1024, total - sent);
        const at = sent % (pool.length - n);
        sent += n;
        this.push(pool.subarray(at, at + n));
      });
    },
  });
}

let outcome = null;
let source = null;
const server = http.createServer(async (_req, res) => {
  res.writeHead(200, { "content-type": "application/zip" });
  const writer = new StreamingZipWriter(null, { outputStream: res, tempDir });
  source = yieldingSource();
  try {
    await writer.open();
    await writer.addStream(source, "big.bin");
    await writer.finalize();
    outcome = "finished";
  } catch (err) {
    await writer.abort();
    outcome = err?.code || "error";
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));

const outcomes = [];
let sourcesLeftOpen = 0;
for (let attempt = 0; attempt < attempts; attempt++) {
  outcome = null;
  const gone = new AbortController();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: gone.signal });
  const reader = response.body.getReader();
  let got = 0;
  while (got < 64 * 1024) {
    const { value, done } = await reader.read();
    if (done) break;
    got += value.length;
  }
  gone.abort();
  for (const started = Date.now(); outcome === null && Date.now() - started < 2000; ) {
    await new Promise((done) => setTimeout(done, 20));
  }
  outcomes.push(outcome ?? "hung");
  if (!source.destroyed) sourcesLeftOpen++;
}
const tempFilesLeft = fs.readdirSync(tempDir);
process.stdout.write(`${JSON.stringify({ attempts, outcomes, sourcesLeftOpen, tempFilesLeft })}\n`);
process.exit(0);
