import fs from "fs";
import path from "path";
import { Transform, Readable } from "stream";
import { pipeline } from "stream/promises";
import { createDeflateRaw, crc32 } from "zlib";

const ZIP64_VERSION = 45;
const UTF8_FLAG = 0x800;
const DATA_DESCRIPTOR_FLAG = 0x8;
const DEFLATED = 8;
const STORED = 0;

function writeUInt16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function writeUInt32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function writeUInt64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(Math.trunc(value)), 0);
  return buffer;
}

function zip64Extra(uncompressedSize, compressedSize, offset) {
  const hasOffset = offset !== undefined;
  const data = Buffer.alloc(hasOffset ? 24 : 16);
  data.writeBigUInt64LE(BigInt(Math.trunc(uncompressedSize)), 0);
  data.writeBigUInt64LE(BigInt(Math.trunc(compressedSize)), 8);
  if (hasOffset) data.writeBigUInt64LE(BigInt(Math.trunc(offset)), 16);

  return Buffer.concat([writeUInt16(1), writeUInt16(data.length), data]);
}

function dosDateTime(date) {
  const validDate = date instanceof Date && Number.isFinite(date.getTime())
    ? date
    : new Date();
  const year = Math.min(Math.max(validDate.getFullYear(), 1980), 2107);
  const dosDate =
    ((year - 1980) << 9) |
    ((validDate.getMonth() + 1) << 5) |
    validDate.getDate();
  const dosTime =
    (validDate.getHours() << 11) |
    (validDate.getMinutes() << 5) |
    Math.floor(validDate.getSeconds() / 2);
  return { dosDate, dosTime };
}

function normalizeName(name, directory = false) {
  const normalized = String(name ?? "").replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "..")) {
    throw new Error(`Invalid ZIP entry name: ${name}`);
  }
  return `${segments.join("/")}${directory ? "/" : ""}`;
}

function streamGone() {
  const error = new Error("The ZIP output was closed");
  error.code = "ERR_STREAM_DESTROYED";
  return error;
}

// Resolves once `stream` took the chunk. An HTTP response whose client went
// away never calls back a write it had to hold (http's OutgoingMessage drops
// the callback when its socket is already destroyed, and never flushes what
// it buffered), so a stream that is destroyed, or closes while the write
// waits, fails the write instead of leaving it pending forever.
function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.destroyed) {
      reject(streamGone());
      return;
    }
    let settled = false;
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(streamGone());

    stream.once("error", onError);
    stream.once("close", onClose);
    try {
      stream.write(chunk, (error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

function openStream(stream) {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    // Destroyed before it opened (an abort while open() waits).
    const onClose = () => {
      cleanup();
      reject(streamGone());
    };
    const cleanup = () => {
      stream.off("open", onOpen);
      stream.off("error", onError);
      stream.off("close", onClose);
    };

    stream.once("open", onOpen);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

// Resolves once `stream` has closed (at once when there is none, or it has).
function streamClosed(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.closed) {
      resolve();
      return;
    }
    stream.once("close", resolve);
  });
}

function closeStream(stream) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => stream.off("error", onError);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);

    stream.once("error", onError);
    stream.end((error) => finish(error));
  });
}

function localFileHeader(name, date) {
  const nameBytes = Buffer.from(name, "utf8");
  const extra = zip64Extra(0, 0);
  const header = Buffer.alloc(30 + nameBytes.length + extra.length);
  writeUInt32(0x04034b50).copy(header, 0);
  writeUInt16(ZIP64_VERSION).copy(header, 4);
  writeUInt16(UTF8_FLAG | DATA_DESCRIPTOR_FLAG).copy(header, 6);
  writeUInt16(DEFLATED).copy(header, 8);
  writeUInt16(date.dosTime).copy(header, 10);
  writeUInt16(date.dosDate).copy(header, 12);
  writeUInt32(0).copy(header, 14);
  writeUInt32(0).copy(header, 18);
  writeUInt32(0).copy(header, 22);
  writeUInt16(nameBytes.length).copy(header, 26);
  writeUInt16(extra.length).copy(header, 28);
  nameBytes.copy(header, 30);
  extra.copy(header, 30 + nameBytes.length);
  return header;
}

function localDirectoryHeader(name, date) {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(30 + nameBytes.length);
  writeUInt32(0x04034b50).copy(header, 0);
  writeUInt16(20).copy(header, 4);
  writeUInt16(UTF8_FLAG).copy(header, 6);
  writeUInt16(STORED).copy(header, 8);
  writeUInt16(date.dosTime).copy(header, 10);
  writeUInt16(date.dosDate).copy(header, 12);
  writeUInt32(0).copy(header, 14);
  writeUInt32(0).copy(header, 18);
  writeUInt32(0).copy(header, 22);
  writeUInt16(nameBytes.length).copy(header, 26);
  writeUInt16(0).copy(header, 28);
  nameBytes.copy(header, 30);
  return header;
}

function centralHeader({ name, date, method, crc, compressedSize, size, offset, directory }) {
  const nameBytes = Buffer.from(name, "utf8");
  const extra = directory
    ? Buffer.alloc(0)
    : zip64Extra(size, compressedSize, offset);
  const header = Buffer.alloc(46 + nameBytes.length + extra.length);
  writeUInt32(0x02014b50).copy(header, 0);
  writeUInt16(directory ? 20 : ZIP64_VERSION).copy(header, 4);
  writeUInt16(directory ? 20 : ZIP64_VERSION).copy(header, 6);
  writeUInt16(UTF8_FLAG | (directory ? 0 : DATA_DESCRIPTOR_FLAG)).copy(header, 8);
  writeUInt16(method).copy(header, 10);
  writeUInt16(date.dosTime).copy(header, 12);
  writeUInt16(date.dosDate).copy(header, 14);
  writeUInt32(crc).copy(header, 16);
  writeUInt32(directory ? 0 : 0xffffffff).copy(header, 20);
  writeUInt32(directory ? 0 : 0xffffffff).copy(header, 24);
  writeUInt16(nameBytes.length).copy(header, 28);
  writeUInt16(extra.length).copy(header, 30);
  writeUInt16(0).copy(header, 32);
  writeUInt16(0).copy(header, 34);
  writeUInt16(0).copy(header, 36);
  writeUInt32(directory ? ((0o40755 << 16) | 0x10) : (0o100644 << 16)).copy(header, 38);
  writeUInt32(directory ? 0 : 0xffffffff).copy(header, 42);
  nameBytes.copy(header, 46);
  extra.copy(header, 46 + nameBytes.length);
  return header;
}

function dataDescriptor(crc, compressedSize, size) {
  const needsZip64 = compressedSize > 0xfffffffe || size > 0xfffffffe;
  return Buffer.concat([
    writeUInt32(0x08074b50),
    writeUInt32(crc),
    needsZip64 ? writeUInt64(compressedSize) : writeUInt32(compressedSize),
    needsZip64 ? writeUInt64(size) : writeUInt32(size),
  ]);
}

function zip64End(entryCount, centralSize, centralOffset) {
  const endOffset = centralOffset + centralSize;
  const end = Buffer.concat([
    writeUInt32(0x06064b50),
    writeUInt64(44),
    writeUInt16(ZIP64_VERSION),
    writeUInt16(ZIP64_VERSION),
    writeUInt32(0),
    writeUInt32(0),
    writeUInt64(entryCount),
    writeUInt64(entryCount),
    writeUInt64(centralSize),
    writeUInt64(centralOffset),
  ]);
  const locator = Buffer.concat([
    writeUInt32(0x07064b50),
    writeUInt32(0),
    writeUInt64(endOffset),
    writeUInt32(1),
  ]);
  const classic = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0xffff),
    writeUInt16(0xffff),
    writeUInt32(0xffffffff),
    writeUInt32(0xffffffff),
    writeUInt16(0),
  ]);
  return Buffer.concat([end, locator, classic]);
}

export class StreamingZipWriter {
  // outputStream (optional): a writable stream that is already open, such as
  // an HTTP response, used instead of creating outputPath. tempDir
  // (optional): where the central-directory temp file goes; defaults to
  // outputPath's folder, which is required when there's no outputPath.
  // Both are additive: a backup passes neither and behaves as before.
  constructor(outputPath, { level = 6, outputStream = null, tempDir = null } = {}) {
    this.outputPath = outputPath;
    this.outputStream = outputStream;
    this.centralPath = path.join(
      tempDir || path.dirname(outputPath),
      `.central-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    this.level = level;
    this.output = null;
    this.central = null;
    this.centralReader = null;
    this.offset = 0;
    this.entryCount = 0;
    this.finalized = false;
    this.aborted = false;
    // The streams of the entry being written, so abort() can stop it.
    this.activeEntry = null;
  }

  assertUsable() {
    if (this.aborted) throw streamGone();
    if (this.finalized) throw new Error("ZIP writer is already finalized");
  }

  async open() {
    if (this.aborted) throw streamGone();
    if (this.output) return;
    await fs.promises.rm(this.centralPath, { force: true });
    // Aborted while the old temp file was being removed: an abort is final,
    // so nothing is created again (nothing would ever remove it).
    if (this.aborted) throw streamGone();
    // A caller-supplied output stream is already open (an HTTP response
    // never emits "open"), so only the streams created here are awaited.
    this.output = this.outputStream || fs.createWriteStream(this.outputPath);
    this.central = fs.createWriteStream(this.centralPath);
    this.output.on("error", () => {});
    this.central.on("error", () => {});
    try {
      await Promise.all([
        this.outputStream ? Promise.resolve() : openStream(this.output),
        openStream(this.central),
      ]);
    } catch (error) {
      await this.abort();
      throw error;
    }
  }

  async addDirectory(name, date = new Date()) {
    await this.open();
    this.assertUsable();
    const normalizedName = normalizeName(name, true);
    const entryDate = dosDateTime(date);
    const offset = this.offset;
    await this.writeOutput(localDirectoryHeader(normalizedName, entryDate));
    await this.writeCentral(
      centralHeader({
        name: normalizedName,
        date: entryDate,
        method: STORED,
        crc: 0,
        compressedSize: 0,
        size: 0,
        offset,
        directory: true,
      }),
    );
    this.entryCount += 1;
  }

  async addFile(filePath, name, date = null) {
    const stats = await fs.promises.lstat(filePath);
    if (!stats.isFile()) throw new Error(`Backup source is not a regular file: ${filePath}`);
    return this.addStream(
      fs.createReadStream(filePath),
      name,
      date || stats.mtime,
    );
  }

  async addBuffer(buffer, name) {
    return this.addStream(Readable.from([buffer]), name, new Date());
  }

  async addStream(source, name, date = new Date()) {
    let normalizedName;
    const entryDate = dosDateTime(date);
    const offset = this.offset;
    try {
      await this.open();
      this.assertUsable();
      normalizedName = normalizeName(name);
      await this.writeOutput(localFileHeader(normalizedName, entryDate));
    } catch (error) {
      // Never read: its file handle (addFile's read stream) is let go here.
      source.destroy?.();
      throw error;
    }

    let checksum = 0;
    let size = 0;
    let compressedSize = 0;
    const checksumTransform = new Transform({
      transform: (chunk, _encoding, callback) => {
        try {
          checksum = crc32(chunk, checksum);
          size += chunk.length;
          callback(null, chunk);
        } catch (error) {
          callback(error);
        }
      },
    });
    const deflate = createDeflateRaw({ level: this.level });
    const pump = pipeline(source, checksumTransform, deflate);
    // Awaited below; an abort can make it fail before that.
    pump.catch(() => {});
    const entry = { source, checksumTransform, deflate };
    this.activeEntry = entry;

    try {
      for await (const chunk of deflate) {
        compressedSize += chunk.length;
        await this.writeOutput(chunk);
      }
      await pump;
      if (this.aborted) throw streamGone();
    } catch (error) {
      source.destroy();
      checksumTransform.destroy();
      deflate.destroy();
      await pump.catch(() => {});
      // Whatever the stopped streams said, the reason is the abort.
      throw this.aborted ? streamGone() : error;
    } finally {
      if (this.activeEntry === entry) this.activeEntry = null;
    }

    await this.writeOutput(dataDescriptor(checksum, compressedSize, size));
    await this.writeCentral(
      centralHeader({
        name: normalizedName,
        date: entryDate,
        method: DEFLATED,
        crc: checksum,
        compressedSize,
        size,
        offset,
        directory: false,
      }),
    );
    this.entryCount += 1;
  }

  async writeOutput(chunk) {
    await writeChunk(this.output, chunk);
    this.offset += chunk.length;
  }

  async writeCentral(chunk) {
    await writeChunk(this.central, chunk);
  }

  async finalize() {
    this.assertUsable();
    await this.open();
    await closeStream(this.central);
    this.central = null;
    const centralOffset = this.offset;
    const centralReader = fs.createReadStream(this.centralPath);
    this.centralReader = centralReader;
    try {
      for await (const chunk of centralReader) {
        await this.writeOutput(chunk);
      }
    } finally {
      this.centralReader = null;
      centralReader.destroy();
    }
    const centralSize = this.offset - centralOffset;
    await this.writeOutput(
      zip64End(this.entryCount, centralSize, centralOffset),
    );
    await closeStream(this.output);
    this.output = null;
    this.finalized = true;
    await fs.promises.rm(this.centralPath, { force: true });
    return { size: this.offset, entries: this.entryCount };
  }

  // Final: stops the entry being written (its source is destroyed, so its
  // file handle or SFTP read is let go), destroys the output, and removes the
  // central-directory temp file once its stream has closed (Windows won't
  // remove a file that is still open). Every later call fails.
  async abort() {
    this.aborted = true;
    const entry = this.activeEntry;
    this.activeEntry = null;
    if (entry) {
      entry.source.destroy?.();
      entry.checksumTransform.destroy();
      entry.deflate.destroy();
    }
    this.centralReader?.destroy();
    const central = this.central;
    this.output?.destroy();
    central?.destroy();
    this.output = null;
    this.central = null;
    await streamClosed(central);
    await fs.promises.rm(this.centralPath, { force: true });
  }
}