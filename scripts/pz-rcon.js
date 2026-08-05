// Minimal Source RCON client for maintenance tasks.
// PZ sends an empty packet before the real reply, so responses are buffered
// until the socket goes quiet instead of exiting on the first packet.
const net = require("net");

const HOST = process.env.RCON_HOST || "127.0.0.1";
const PORT = Number(process.env.RCON_PORT || 27015);
const PASS = process.env.RCON_PASS || "";
const COMMAND = process.argv.slice(2).join(" ");

if (!PASS) {
  console.error("RCON_PASS is required");
  process.exit(2);
}
if (!COMMAND) {
  console.error("usage: node pz-rcon.js <command>");
  process.exit(2);
}

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;

function packet(id, type, body) {
  const payload = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeInt16LE(0, 12 + payload.length);
  return buf;
}

const socket = net.createConnection({ host: HOST, port: PORT }, () => {
  socket.write(packet(1, SERVERDATA_AUTH, PASS));
});

let buffer = Buffer.alloc(0);
let authed = false;
const lines = [];
let quietTimer = null;

function finish(code) {
  if (quietTimer) clearTimeout(quietTimer);
  socket.end();
  const text = lines.join("\n").trim();
  if (text) console.log(text);
  process.exit(code);
}

socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const size = buffer.readInt32LE(0);
    if (buffer.length < size + 4) break;
    const id = buffer.readInt32LE(4);
    const body = buffer.slice(12, 4 + size - 2).toString("utf8");
    buffer = buffer.slice(4 + size);

    if (!authed) {
      if (id === -1) {
        console.error("RCON authentication failed");
        finish(1);
        return;
      }
      authed = true;
      socket.write(packet(2, SERVERDATA_EXECCOMMAND, COMMAND));
      continue;
    }
    if (body) lines.push(body);
  }

  if (authed) {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => finish(0), 1200);
  }
});

socket.on("error", (err) => {
  console.error(`RCON error: ${err.message}`);
  process.exit(1);
});

setTimeout(() => finish(authed ? 0 : 1), 20000);
