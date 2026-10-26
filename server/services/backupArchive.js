import { EventEmitter } from "events";
import fs from "fs";
import { StreamingZipWriter } from "../utils/streamingZip.js";

// The part of archiver's interface that createBackup() uses ("entry",
// "warning" and "error" events; file, append, finalize, pointer, abort,
// destroy), written to disk by StreamingZipWriter. archiver keeps an object
// for every entry in the JS heap until finalize(), which ran a world of
// ~870,000 files out of Node's 4 GB heap and took the panel, and in the
// all-in-one image the game server, down (#259). StreamingZipWriter spools
// the central directory to a temp file instead, so memory no longer grows
// with the file count.
export class StreamingBackupArchive extends EventEmitter {
  constructor(outputPath, output, { level = 6 } = {}) {
    super();
    this.writer = new StreamingZipWriter(outputPath, { level, outputStream: output });
    this.errored = null;
    this.aborted = false;
    this.bytes = 0;
    this.chain = Promise.resolve();
  }

  // A file or folder (a name ending in "/") on disk. A path that has vanished
  // emits a warning with code ENOENT and no "entry", as archiver does.
  file(fullPath, { name }) {
    this.enqueue(name, async () => {
      let stats;
      try {
        stats = await fs.promises.lstat(fullPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        this.emit("warning", error);
        return false;
      }
      if (stats.isDirectory()) {
        await this.writer.addDirectory(name, stats.mtime);
      } else {
        await this.writer.addFile(fullPath, name, stats.mtime);
      }
      return true;
    });
  }

  append(data, { name }) {
    this.enqueue(name, async () => {
      await this.writer.addBuffer(Buffer.from(data), name);
      return true;
    });
  }

  enqueue(name, add) {
    this.chain = this.chain.then(async () => {
      if (this.aborted || this.errored) return;
      try {
        if (await add()) this.emit("entry", { name });
      } catch (error) {
        if (this.aborted || this.errored) return;
        this.errored = error;
        this.emit("error", error);
      }
    });
  }

  async finalize() {
    this.finalizing = this.runFinalize();
    await this.finalizing;
  }

  // Resolves once finalize() is done, which includes removing the
  // central-directory temp file, so a backup folder listed right after is clean.
  async settled() {
    await this.finalizing;
  }

  async runFinalize() {
    await this.chain;
    if (this.aborted || this.errored) return;
    try {
      const { size } = await this.writer.finalize();
      this.bytes = size;
    } catch (error) {
      if (this.aborted || this.errored) return;
      this.errored = error;
      this.emit("error", error);
    }
  }

  pointer() {
    return this.bytes;
  }

  abort() {
    this.aborted = true;
    this.writer.abort().catch(() => {});
  }

  destroy(error) {
    if (error && !this.errored) this.errored = error;
    this.abort();
  }
}
