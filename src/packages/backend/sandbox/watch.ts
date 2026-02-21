import { readFile } from "node:fs/promises";
import { watch as chokidarWatch } from "chokidar";
import { EventIterator } from "@cocalc/util/event-iterator";
import { type WatchOptions, type ChangeEvent } from "@cocalc/conat/files/watch";
import { EventEmitter } from "events";
import LRU from "lru-cache";
import TTL from "@isaacs/ttlcache";
import getLogger from "@cocalc/backend/logger";
import { DiffMatchPatch, compressPatch } from "@cocalc/util/dmp";
import { sha1 } from "@cocalc/backend/sha1";
import { trackBackendWatcher } from "../watcher-debug";

// this is used specifically for loading from disk, where the patch
// explaining the last change on disk gets merged into the live version
// of the doc, so there is likely to difficulty matching, but we
// very much don't want to discard the changes:
const dmp = new DiffMatchPatch({
  // running on server so critical to not block long!
  diffTimeout: 0.15,
});

const logger = getLogger("sandbox:watch");

export { type WatchOptions };
export type WatchIterator = EventIterator<ChangeEvent>;

const DEFAULT_POLL_INTERVAL = (() => {
  const raw = process.env.COCALC_SANDBOX_WATCH_POLL_INTERVAL_MS;
  if (raw == null || raw === "") {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(
      "invalid COCALC_SANDBOX_WATCH_POLL_INTERVAL_MS; expected nonnegative integer",
      { value: raw },
    );
    return 0;
  }
  return parsed;
})();

// do NOT use patch for tracking file changes if the file exceeds
// this size.  The reason is mainly because computing diffs of
// large files on the server can take a long time!
const MAX_PATCH_FILE_SIZE = 1_000_000;

//const log = (...args) => console.log(...args);
const log = (..._args) => {};

export default async function watch(
  path: string,
  options: WatchOptions,
  lastOnDisk: LRU<string, string>,
  lastOnDiskHash: TTL<string, boolean>,
): Promise<WatchIterator> {
  log("watch", path, options);
  const watcher = new Watcher(path, options, lastOnDisk, lastOnDiskHash);
  await watcher.waitUntilReady();

  const iter = new EventIterator(watcher, "change", {
    maxQueue: options.maxQueue ?? 2048,
    overflow: options.overflow,
    map: (args) => args[0],
    onEnd: () => {
      log("onEnd:", path);
      watcher.close();
    },
  });
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      iter.end();
    });
  }

  return iter;
}

class Watcher extends EventEmitter {
  private watcher: ReturnType<typeof chokidarWatch>;
  private ready: boolean = false;
  private readonly readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private patchSeq: number = 0;
  private stopTrackingWatcher?: () => void;

  constructor(
    private path: string,
    private options: WatchOptions,
    private lastOnDisk: LRU<string, string>,
    private lastOnDiskHash: TTL<string, boolean>,
  ) {
    super();
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    const stabilityThreshold = options.stabilityThreshold ?? 500;
    const pollInterval = Math.max(
      0,
      options.pollInterval ?? DEFAULT_POLL_INTERVAL,
    );
    const usePolling = pollInterval > 0;
    const trackerInfo: Record<string, unknown> = {
      usePolling,
      pollInterval,
      stabilityThreshold,
      closeOnUnlink: !!options.closeOnUnlink,
      patch: !!options.patch,
    };
    const chokidarConfig = {
      depth: 0,
      ignoreInitial: true,
      followSymlinks: false,
      alwaysStat: options.stats ?? false,
      atomic: true,
      usePolling,
      interval: usePolling ? pollInterval : undefined,
      awaitWriteFinish: stabilityThreshold
        ? {
            stabilityThreshold,
            pollInterval: stabilityThreshold / 2,
          }
        : undefined,
    };
    this.stopTrackingWatcher = trackBackendWatcher({
      source: "backend:sandbox/watch",
      type: "chokidar",
      path,
      info: trackerInfo,
    });
    this.watcher = chokidarWatch(path, chokidarConfig);

    this.watcher.once("ready", () => {
      this.ready = true;
      const getWatched = (this.watcher as any).getWatched;
      if (typeof getWatched === "function") {
        try {
          const watched = getWatched.call(this.watcher) as Record<
            string,
            string[]
          >;
          let watchedDirs = 0;
          let watchedEntries = 0;
          for (const names of Object.values(watched)) {
            watchedDirs += 1;
            watchedEntries += Array.isArray(names) ? names.length : 0;
          }
          trackerInfo.watchedDirs = watchedDirs;
          trackerInfo.watchedEntries = watchedEntries;
          if (usePolling && watchedEntries >= 500) {
            logger.warn("polling sandbox watcher has large watch-set", {
              path,
              pollInterval,
              watchedDirs,
              watchedEntries,
            });
          }
        } catch (err) {
          trackerInfo.watchedStatsError = `${err}`;
        }
      }
      this.readyResolve?.();
      this.readyResolve = null;
    });
    this.watcher.on("all", async (...args) => {
      const change = await this.handle(...args);
      if (change !== undefined) {
        this.emit("change", change);
      }
    });
    this.watcher.on("error", (error) => {
      logger.debug(path, "got error", error);
    });
  }

  handle = async (event, path, stats): Promise<undefined | ChangeEvent> => {
    if (!this.ready) {
      return;
    }
    // note: if this.path *is* a file, then filename:"" below.
    let filename = path.slice(this.path.length);
    if (filename.startsWith("/")) {
      filename = filename.slice(1);
    }
    const x: ChangeEvent = { event, filename };
    if (this.options.stats) {
      x.stats = stats;
    }
    if (this.options.closeOnUnlink && path == this.path) {
      this.emit("change", x);
      this.close();
      return;
    }
    if (!this.options.patch) {
      log(path, "patch option not set", this.options);
      return x;
    }

    const last = this.lastOnDisk.get(path);
    if (last === undefined) {
      log(path, "lastOnDisk not set");
      return x;
    }
    let cur;
    try {
      cur = await readFile(path, "utf8");
    } catch (err) {
      log(path, "read error", err);
      return x;
    }
    if (last == cur) {
      // no change
      return;
    }
    if (this.lastOnDiskHash.get(`${path}-${sha1(cur)}`)) {
      // file is equal to a very RECENTLY-saved-by-browser client version,
      // so not firing event.
      return;
    }
    this.lastOnDisk.set(path, cur);
    this.lastOnDiskHash.set(`${path}-${sha1(cur)}`, true);
    if (
      cur.length >= MAX_PATCH_FILE_SIZE ||
      last.length >= MAX_PATCH_FILE_SIZE
    ) {
      // just inform that there is a change
      log(path, "patch -- file too big (cur)");
      return x;
    }
    // small enough to make a patch
    //log(path, "making a patch with ", last.length, cur.length);
    // const t = Date.now();
    x.patch = compressPatch(dmp.patch_make(last, cur));
    x.patchSeq = this.patchSeq;
    this.patchSeq++;
    //log(path, "made patch", { time: Date.now() - t, seq: x.patchSeq }, x.patch);
    return x;
  };

  waitUntilReady = async (): Promise<void> => {
    if (this.ready) {
      return;
    }
    await this.readyPromise;
  };

  close() {
    log(this.path, "close()");
    this.stopTrackingWatcher?.();
    this.stopTrackingWatcher = undefined;
    this.watcher?.close();
    this.emit("close");
    this.removeAllListeners();
    // @ts-ignore
    delete this.watcher;
    // @ts-ignore
    delete this.ready;
  }
}
