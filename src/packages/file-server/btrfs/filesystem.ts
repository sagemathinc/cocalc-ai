/*
BTRFS Filesystem

DEVELOPMENT:

Start node, then:

DEBUG="cocalc:*file-server*" DEBUG_CONSOLE=yes node

a = require('@cocalc/file-server/btrfs'); fs = await a.filesystem({image:'/tmp/btrfs.img', mount:'/mnt/btrfs', size:'2G'})

*/

import refCache from "@cocalc/util/refcache";
import { mkdirp, btrfs, sudo, ensureMoreLoopbackDevices } from "./util";
import { Subvolumes } from "./subvolumes";
import { mkdir } from "node:fs/promises";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import { ensureInitialized } from "@cocalc/backend/sandbox/rustic";
import { until } from "@cocalc/util/async-utils";
import { delay } from "awaiting";
import { FileSync } from "./sync";
import bees from "./bees";
import { type ChildProcess } from "node:child_process";
import { install } from "@cocalc/backend/sandbox/install";

import getLogger from "@cocalc/backend/logger";

const logger = getLogger("file-server:btrfs:filesystem");

export interface Options {
  // mount = root mountpoint of the btrfs filesystem. If you specify the image
  // path below, then a btrfs filesystem will get automatically created (via sudo
  // and a loopback device).
  mount: string;

  // image = optionally use a image file at this location for the btrfs filesystem.
  // This is used for **development** (not a serious deployment).  It will be
  // created as a sparse image file
  // with given size, and mounted at opts.mount if it does not exist.  If you create
  // it be sure to use mkfs.btrfs to format it.
  image?: string;
  size?: string | number;

  // rustic = the rustic backups path.
  // If this path ends in .toml, it is the configuration file for rustic, e.g., you can
  // configure rustic however you want by pointing this at a toml cofig file.
  // Otherwise, if this path does not exist, it will be created a new rustic repo
  // initialized here.
  rustic: string;
}

let mountLock = false;

export class Filesystem {
  public readonly opts: Options;
  public readonly subvolumes: Subvolumes;
  public readonly fileSync: FileSync;
  private bees?: ChildProcess;
  private beesRestartTimer?: NodeJS.Timeout;
  private beesRestartAttempts = 0;
  private beesDisabledByConfig = false;
  private beesStopping = false;
  private beesLastExit?: {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  };

  constructor(opts: Options) {
    this.opts = opts;
    this.subvolumes = new Subvolumes(this);
    this.fileSync = new FileSync(this);
  }

  init = async () => {
    await mkdirp([this.opts.mount]);
    await this.initDevice();
    await this.mountFilesystem();
    await this.sync();
    try {
      await this.fileSync.init();
    } catch (err) {
      // [ ] TODO: this error is expected right now if mutagen not installed.
      // We will rewrite this to use reflect-sync, integrated with cocalc.
      logger.debug(
        "Error starting file sync service -- sync not available",
        err,
      );
    }
    // 'quota enable --simple' has a lot of subtle issues, and maybe isn't for us.
    // It also resets to zero when you disable then enable, and there is no efficient
    // way to get the numbers.
    await btrfs({
      args: ["quota", "enable", this.opts.mount],
    });
    try {
      await this.initRustic();
    } catch (err) {
      logger.debug(
        "Error starting rustic backup service -- backup not available",
        err,
      );
    }
    await this.sync();
    await this.startBees("startup");
  };

  sync = async () => {
    await btrfs({ args: ["filesystem", "sync", this.opts.mount] });
  };

  unmount = async () => {
    await sudo({
      command: "umount",
      args: [this.opts.mount],
      err_on_exit: true,
    });
  };

  close = () => {
    this.beesStopping = true;
    if (this.beesRestartTimer) {
      clearTimeout(this.beesRestartTimer);
      this.beesRestartTimer = undefined;
    }
    this.bees?.kill("SIGQUIT");
    this.fileSync.close();
  };

  getBeesStatus = () => {
    return {
      enabled: !this.beesDisabledByConfig,
      running:
        !this.beesDisabledByConfig &&
        this.bees != null &&
        this.bees.killed !== true &&
        this.bees.exitCode == null,
      pid: this.bees?.pid,
      restartAttempts: this.beesRestartAttempts,
      restartPending: this.beesRestartTimer != null,
      lastExit: this.beesLastExit,
    };
  };

  private scheduleBeesRestart(reason: string) {
    if (this.beesStopping || this.beesDisabledByConfig) {
      return;
    }
    if (this.beesRestartTimer) {
      return;
    }
    this.beesRestartAttempts += 1;
    const delayMs = Math.min(
      60_000,
      Math.max(1_000, 2 ** (this.beesRestartAttempts - 1) * 1_000),
    );
    logger.warn("scheduling BEES restart", {
      mount: this.opts.mount,
      reason,
      attempt: this.beesRestartAttempts,
      delayMs,
    });
    this.beesRestartTimer = setTimeout(() => {
      this.beesRestartTimer = undefined;
      void this.startBees(`restart:${reason}`);
    }, delayMs);
    this.beesRestartTimer.unref();
  }

  private async startBees(reason: string): Promise<void> {
    if (this.beesStopping) {
      return;
    }
    try {
      const child = await bees(this.opts.mount);
      if (!child) {
        this.bees = undefined;
        this.beesDisabledByConfig = true;
        logger.warn("BEES dedup disabled by configuration", {
          mount: this.opts.mount,
          reason,
        });
        return;
      }
      this.bees = child;
      this.beesDisabledByConfig = false;
      this.beesRestartAttempts = 0;
      logger.info("BEES dedup service running", {
        mount: this.opts.mount,
        pid: child.pid,
        reason,
      });
      child.once("exit", (code, signal) => {
        if (this.bees !== child) return;
        this.bees = undefined;
        this.beesLastExit = {
          code: code ?? null,
          signal: signal ?? null,
          at: new Date().toISOString(),
        };
        if (this.beesStopping) {
          logger.info("BEES dedup service stopped", {
            mount: this.opts.mount,
            code,
            signal,
          });
          return;
        }
        logger.error("BEES dedup service exited unexpectedly", {
          mount: this.opts.mount,
          code,
          signal,
        });
        this.scheduleBeesRestart("unexpected-exit");
      });
    } catch (err) {
      logger.error("Error starting BEES dedup service", {
        mount: this.opts.mount,
        reason,
        err: `${err}`,
      });
      this.scheduleBeesRestart("start-failure");
    }
  }

  private initDevice = async () => {
    if (!this.opts.image) {
      return;
    }
    if (!(await exists(this.opts.image))) {
      // we create and format the sparse image
      await sudo({
        command: "truncate",
        args: ["-s", `${this.opts.size ?? "10G"}`, this.opts.image],
      });
      await sudo({ command: "mkfs.btrfs", args: [this.opts.image] });
    }
  };

  info = async (): Promise<{ [field: string]: string }> => {
    const { stdout } = await btrfs({
      args: ["subvolume", "show", this.opts.mount],
    });
    const obj: { [field: string]: string } = {};
    for (const x of stdout.split("\n")) {
      const i = x.indexOf(":");
      if (i == -1) continue;
      obj[x.slice(0, i).trim()] = x.slice(i + 1).trim();
    }
    return obj;
  };

  private mountFilesystem = async () => {
    try {
      await this.info();
      // already mounted
      return;
    } catch {}
    const { stderr, exit_code } = await this._mountFilesystem();
    if (exit_code) {
      throw Error(stderr);
    }
  };

  private _mountFilesystem = async () => {
    if (!this.opts.image) {
      throw Error(`there must be a btrfs image at ${this.opts.image}`);
    }
    await until(() => !mountLock);
    try {
      mountLock = true;
      const args: string[] = ["-o", "loop"];
      args.push(
        "-o",
        "compress=zstd",
        "-o",
        "noatime",
        "-o",
        "space_cache=v2",
        "-o",
        "autodefrag",
        this.opts.image,
        "-t",
        "btrfs",
        this.opts.mount,
      );
      {
        const { exit_code: failed } = await sudo({
          command: "mount",
          args,
          err_on_exit: false,
        });
        if (failed) {
          // try again with more loopback devices
          await ensureMoreLoopbackDevices();
          const { stderr, exit_code } = await sudo({
            command: "mount",
            args,
            err_on_exit: false,
          });
          if (exit_code) {
            return { stderr, exit_code };
          }
        }
      }
      await until(
        async () => {
          try {
            await sudo({
              command: "df",
              args: ["-t", "btrfs", this.opts.mount],
            });
            return true;
          } catch (err) {
            console.log(err);
            return false;
          }
        },
        { min: 250 },
      );
      const { stderr, exit_code } = await sudo({
        command: "chown",
        args: [
          `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          this.opts.mount,
        ],
        err_on_exit: false,
      });
      return { stderr, exit_code };
    } finally {
      await delay(1000);
      mountLock = false;
    }
  };

  private initRustic = async () => {
    if (!this.opts.rustic) {
      return;
    }
    // ensure correct version of rustic is installed locally
    await install("rustic");
    if (this.opts.rustic.endsWith(".toml")) {
      if (!(await exists(this.opts.rustic))) {
        throw Error(`file not found: ${this.opts.rustic}`);
      }
      await ensureInitialized(this.opts.rustic);
      return;
    }
    if (!(await exists(this.opts.rustic))) {
      await mkdir(this.opts.rustic);
    }
    await ensureInitialized(this.opts.rustic);
  };
}

const cache = refCache<Options & { noCache?: boolean }, Filesystem>({
  name: "btrfs-filesystems",
  createObject: async (options: Options) => {
    const filesystem = new Filesystem(options);
    await filesystem.init();
    return filesystem;
  },
});

export async function filesystem(
  options: Options & { noCache?: boolean },
): Promise<Filesystem> {
  return await cache(options);
}
