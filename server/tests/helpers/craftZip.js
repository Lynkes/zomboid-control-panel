import zlib from "zlib";

// Builds a zip byte for byte, so a test can make one that lies: a recorded
// size that is not the real one, backslash separators (PowerShell 5.1's
// Compress-Archive), or an entry the central directory does not list.
//
// entries: [{ path, data?, method? (8 deflate | 0 store), declaredSize?,
//   cdDeclaredSize?, inCentralDirectory? }]
//   - declaredSize: the uncompressed size written in the local header AND the
//     central directory (default: the real size)
//   - cdDeclaredSize: overrides the central directory's figure only
//   - inCentralDirectory: false leaves the entry out of the central directory
export function craftZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  let count = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    const isDir = entry.path.endsWith("/") || entry.path.endsWith("\\");
    const method = isDir ? 0 : entry.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data, { level: 9 }) : data;
    const crc = zlib.crc32(data);
    const declared = entry.declaredSize ?? data.length;
    const cdDeclared = entry.cdDeclaredSize ?? declared;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    if (entry.inCentralDirectory !== false) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(method, 10);
      central.writeUInt16LE(0, 12);
      central.writeUInt16LE(0x21, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(body.length, 20);
      central.writeUInt32LE(cdDeclared, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(isDir ? 0x10 : 0, 38);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, name);
      count++;
    }
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}
