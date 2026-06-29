/*
Directory Listing

Tests in packages/backend/conat/files/test/listing.test.ts


*/

import { EventEmitter } from "events";
import { join } from "path";
import { type FilesystemClient } from "./fs";
import { EventIterator } from "@cocalc/util/event-iterator";

export type FileTypeLabel = "f" | "d" | "l" | "b" | "c" | "s" | "p";

export const typeDescription = {
  f: "regular file",
  d: "directory",
  l: "symlink",
  b: "block device",
  c: "character device",
  s: "socket",
  p: "fifo",
};

export interface FileData {
  // last modification time as time since epoch in **milliseconds** (as is usual for javascript)
  mtime: number;
  size: number;
  // isDir = mainly for backward compat:
  isDir?: boolean;
  // issymlink = mainly for backward compat:
  isSymLink?: boolean;
  linkTarget?: string;
  // see typeDescription above.
  type?: FileTypeLabel;
}

export type Files = { [name: string]: FileData };

interface Options {
  path: string;
  fs: FilesystemClient;
}

export default async function listing(opts: Options): Promise<Listing> {
  const listing = new Listing(opts);
  await listing.init();
  return listing;
}

export class Listing extends EventEmitter {
  public files?: Files = {};
  public truncated?: boolean;
  private watch?;
  private iters: EventIterator<FileData & { name: string }>[] = [];
  constructor(public readonly opts: Options) {
    super();
  }

  iter = () => {
    const iter = new EventIterator(this, "change", {
      map: (args) => {
        return { name: args[0], ...args[1] };
      },
    });
    this.iters.push(iter);
    return iter;
  };

  close = () => {
    this.emit("closed");
    this.removeAllListeners();
    this.iters.map((iter) => iter.end());
    this.iters.length = 0;
    this.watch?.close();
    delete this.files;
    delete this.watch;
  };

  init = async () => {
    const { fs, path } = this.opts;
    // Do not block initial directory contents on watch bootstrap. In routed
    // browser sessions the watch handshake can lag or wedge during startup,
    // while the one-shot listing succeeds promptly. Rendering current contents
    // is more important than attaching the live watcher first.
    const { files, truncated } = await fs.getListing(path);
    this.files = files;
    this.truncated = truncated;
    this.emit("ready");
    if (typeof fs.watch !== "function") {
      return;
    }
    // closeOnUnlink is critical so that btrfs snapshots don't get locked when
    // we try to delete them.
    void this.attachWatch(fs.watch(path, { closeOnUnlink: true, stats: true }));
  };

  private attachWatch = async (watchPromise: Promise<any>) => {
    try {
      const watch = await watchPromise;
      if (this.files == null) {
        watch?.close?.();
        return;
      }
      this.watch = watch;
      await this.syncAfterWatchAttach();
      void this.handleUpdates();
    } catch (err) {
      if (this.files == null) {
        return;
      }
      if (isUnsupportedWatchError(err)) {
        return;
      }
      console.warn("WARNING:", err);
    }
  };

  private syncAfterWatchAttach = async () => {
    if (this.files == null) {
      return;
    }
    const before = this.files;
    try {
      const { files, truncated } = await this.opts.fs.getListing(
        this.opts.path,
      );
      if (this.files == null) {
        return;
      }
      this.files = files;
      this.truncated = truncated;
      const changed = new Set([
        ...Object.keys(before ?? {}),
        ...Object.keys(files ?? {}),
      ]);
      for (const name of changed) {
        if (!sameFileData(before?.[name], files?.[name])) {
          this.emit("change", name, files?.[name]);
        }
      }
    } catch (err) {
      if (this.files != null) {
        console.warn("WARNING:", err);
      }
    }
  };

  private handleUpdates = async () => {
    for await (const x of this.watch) {
      if (this.files == null) {
        return;
      }
      this.update(x);
    }
  };

  private update = async ({
    filename,
    event,
    stats,
  }: {
    filename: string;
    event;
    stats;
  }) => {
    // console.log("update", { filename, event, stats });
    if (this.files == null) {
      // closed or not initialized yet
      return;
    }
    if (event.startsWith("unlink")) {
      delete this.files[filename];
    } else {
      try {
        stats ??= await this.opts.fs.lstat(join(this.opts.path, filename));
        if (this.files == null) {
          return;
        }
        const data: FileData = {
          mtime: stats.mtimeMs,
          size: stats.size,
        };
        if (stats.type != null) {
          // Some platforms provide a type hint; include it only when present.
          data.type = stats.type;
        }
        if (stats.isSymbolicLink()) {
          // resolve target.
          data.linkTarget = await this.opts.fs.readlink(
            join(this.opts.path, filename),
          );
          data.isSymLink = true;
        }
        if (stats.isDirectory()) {
          data.isDir = true;
        }
        this.files[filename] = data;
      } catch (err) {
        if (this.files == null) {
          return;
        }
        if (err.code == "ENOENT") {
          // file deleted
          delete this.files[filename];
        } else {
          //if (!process.env.COCALC_TEST_MODE) {
          console.warn("WARNING:", err);
          // TODO: some other error -- e.g., network down or permissions, so we don't know anything.
          // Should we retry (?).
          //}
          return;
        }
      }
    }
    this.emit("change", filename, this.files[filename]);
  };
}

function sameFileData(a: FileData | undefined, b: FileData | undefined) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  return (
    a.mtime === b.mtime &&
    a.size === b.size &&
    a.isDir === b.isDir &&
    a.isSymLink === b.isSymLink &&
    a.linkTarget === b.linkTarget &&
    a.type === b.type
  );
}

function isUnsupportedWatchError(err: unknown): boolean {
  const message = `${(err as Error | undefined)?.message ?? err ?? ""}`
    .trim()
    .toLowerCase();
  return (
    message === "watch not defined" || message.includes("watch not defined")
  );
}
