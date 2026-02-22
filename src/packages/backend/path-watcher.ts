/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Watch A DIRECTORY for changes of the files in *that* directory only (not recursive).
Use ./watcher.ts for a single file.

Slightly generalized fs.watch that works even when the directory doesn't exist,
but also doesn't provide any information about what changed.

NOTE: We could maintain the directory listing and just try to update info about the filename,
taking into account the type.  That's probably really hard to get right, and just
debouncing and computing the whole listing is going to be vastly easier and good
enough at least for first round of this.

We assume path is relative to HOME and contained inside of HOME.

The code below deals with two very different cases:
 - when that path doesn't exist: use fs.watch on the parent directory.
        NOTE: this case can't happen when path='', which exists, so we can assume to have read perms on parent.
 - when the path does exist: use fs.watch (hence inotify) on the path itself to report when it changes

IMPORTANT:
Do NOT enable polling here.

Polling with chokidar on large directories can create enormous watcher fanout
and sustained CPU load (e.g., thousands of files causing thousands of polling
checks). This path is security-sensitive because it can be reached by API-driven
watch requests, so allowing polling is an avoidable denial-of-service vector.

If behavior here needs to change in the future, use native fs.watch semantics or
another non-polling approach. Do not reintroduce polling toggles/env flags.
*/

import { watch } from "chokidar";
import { join } from "path";
import { EventEmitter } from "events";
import { debounce } from "lodash";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import { close, path_split } from "@cocalc/util/misc";
import { getLogger } from "./logger";
import { trackBackendWatcher } from "./watcher-debug";

const logger = getLogger("backend:path-watcher");

const DEFAULT_DEBOUNCE_MS = 2000;

const ChokidarOpts = {
  persistent: true, // otherwise won't work
  followSymlinks: false, // don't wander about
  disableGlobbing: true, // watch the path as it is, that's it
  usePolling: false,
  depth: 0, // we only care about the explicitly mentioned path – there could be a lot of files and sub-dirs!
  // maybe some day we want this:
  // awaitWriteFinish: {
  //   stabilityThreshold: 100,
  //   pollInterval: 50,
  // },
  ignorePermissionErrors: true,
  alwaysStat: false,
} as const;

export class Watcher extends EventEmitter {
  private path: string;
  private exists: boolean;
  private watchContents?;
  private watchExistence?;
  private closeWatchContentsTracker?: () => void;
  private closeWatchExistenceTracker?: () => void;
  private debounce_ms: number;
  private debouncedChange: any;
  private log: Function;

  constructor(
    path: string,
    { debounce: debounce_ms = DEFAULT_DEBOUNCE_MS }: { debounce?: number } = {},
  ) {
    super();
    this.log = logger.extend(path).debug;
    this.log("initializing: polling disabled");
    if (process.env.HOME == null) {
      throw Error("bug -- HOME must be defined");
    }
    this.path = path.startsWith("/") ? path : join(process.env.HOME, path);
    this.debounce_ms = debounce_ms;
    this.debouncedChange = this.debounce_ms
      ? debounce(this.change, this.debounce_ms, {
          leading: true,
          trailing: true,
        }).bind(this)
      : this.change;
    this.init();
  }

  private async init(): Promise<void> {
    this.log("init watching", this.path);
    this.exists = await exists(this.path);
    if (this.path != "") {
      this.log("init watching", this.path, " for existence");
      this.initWatchExistence();
    }
    if (this.exists) {
      this.log("init watching", this.path, " contents");
      this.initWatchContents();
    }
  }

  private initWatchContents(): void {
    this.closeWatchContentsTracker?.();
    this.watchContents = watch(this.path, ChokidarOpts);
    this.closeWatchContentsTracker = trackBackendWatcher({
      source: "backend:path-watcher:contents",
      type: "chokidar",
      path: this.path,
      info: {
        usePolling: false,
        depth: ChokidarOpts.depth,
      },
    });
    this.watchContents.on("all", this.debouncedChange);
    this.watchContents.on("error", (err) => {
      this.log(`error watching listings -- ${err}`);
    });
  }

  private async initWatchExistence(): Promise<void> {
    const containing_path = path_split(this.path).head;
    this.closeWatchExistenceTracker?.();
    this.watchExistence = watch(containing_path, ChokidarOpts);
    this.closeWatchExistenceTracker = trackBackendWatcher({
      source: "backend:path-watcher:existence",
      type: "chokidar",
      path: containing_path,
      info: {
        usePolling: false,
        depth: ChokidarOpts.depth,
      },
    });
    this.watchExistence.on("all", this.watchExistenceChange);
    this.watchExistence.on("error", (err) => {
      this.log(`error watching for existence of ${this.path} -- ${err}`);
    });
  }

  private watchExistenceChange = async (_, path) => {
    if (path != this.path) return;
    const e = await exists(this.path);
    if (!this.exists && e) {
      // it sprung into existence
      this.exists = e;
      this.initWatchContents();
      this.change();
    } else if (this.exists && !e) {
      // it got deleted
      this.exists = e;
      if (this.watchContents != null) {
        this.watchContents.close();
        this.closeWatchContentsTracker?.();
        this.closeWatchContentsTracker = undefined;
        delete this.watchContents;
      }

      this.change();
    }
  };

  private change = (): void => {
    this.emit("change");
  };

  public close(): void {
    this.closeWatchExistenceTracker?.();
    this.closeWatchExistenceTracker = undefined;
    this.closeWatchContentsTracker?.();
    this.closeWatchContentsTracker = undefined;
    this.watchExistence?.close();
    this.watchContents?.close();
    close(this);
  }
}

export class MultipathWatcher extends EventEmitter {
  private paths: { [path: string]: Watcher } = {};
  private options;

  constructor(options?) {
    super();
    this.options = options;
  }

  has = (path: string) => {
    return this.paths[path] != null;
  };

  add = (path: string) => {
    if (this.has(path)) {
      // already watching
      return;
    }
    this.paths[path] = new Watcher(path, this.options);
    this.paths[path].on("change", () => this.emit("change", path));
  };

  delete = (path: string) => {
    if (!this.has(path)) {
      return;
    }
    this.paths[path].close();
    delete this.paths[path];
  };

  close = () => {
    for (const path in this.paths) {
      this.delete(path);
    }
  };
}
