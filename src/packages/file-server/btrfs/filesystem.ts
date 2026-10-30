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
import bees, {
  BEES_ALREADY_RUNNING_EXIT_CODE,
  signalBeesProcessGroup,
} from "./bees";
import { type ChildProcess } from "node:child_process";
import { install } from "@cocalc/backend/sandbox/install";
import { getBtrfsQuotaQueueStatus, startBtrfsQuotaQueue } from "./quota-queue";
import {
  ensureBtrfsQuotaModeDetails,
  type BtrfsQuotaRuntimeDetails,
} from "./quota-mode";
import { applyBeesGateAction, BeesGate, beesGateEnabled } from "./bees-gate";
import {
  collectBeesTelemetry,
  recordBeesTelemetryError,
  type BeesTelemetryStatus,
  updateBeesTelemetry,
} from "./bees-telemetry";

import getLogger from "@cocalc/backend/logger";

const logger = getLogger("file-server:btrfs:filesystem");
const DEFAULT_BEES_TELEMETRY_INTERVAL_MS = 5 * 60 * 1000;
const MIN_BEES_TELEMETRY_INTERVAL_MS = 30 * 1000;

function beesTelemetryIntervalMs(): number {
  const value = Number(process.env.COCALC_BEES_TELEMETRY_INTERVAL_MS);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_BEES_TELEMETRY_INTERVAL_MS;
  }
  return Math.max(MIN_BEES_TELEMETRY_INTERVAL_MS, Math.floor(value));
}

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

  // Managed callers can durably account for temporary quota headroom. Return
  // undefined for subvolumes that are not managed by the caller.
  withTemporaryQuotaOverride?: <T>(opts: {
    subvolume_name: string;
    operation: string;
    minimum_bytes: number;
    current_size: number;
    current_used: number;
    run: () => Promise<T>;
  }) => Promise<T> | undefined;

  // Whether projects are starting or stopping now: the BEES gate keeps BEES
  // frozen meanwhile (bees-gate.ts).
  beesLifecycleActive?: () => boolean;
}

let mountLock = false;

export class Filesystem {
  public readonly opts: Options;
  public readonly subvolumes: Subvolumes;
  private bees?: ChildProcess;
  private beesRunningExternally = false;
  private beesRestartTimer?: NodeJS.Timeout;
  private beesRestartAttempts = 0;
  private beesTelemetry?: BeesTelemetryStatus;
  private beesTelemetryTimer?: NodeJS.Timeout;
  private beesTelemetryRunning = false;
  private beesDisabledByConfig = false;
  private beesStopping = false;
  private beesGate?: BeesGate;
  private quotaRuntime?: BtrfsQuotaRuntimeDetails;
  private beesLastExit?: {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  };

  constructor(opts: Options) {
    this.opts = opts;
    this.subvolumes = new Subvolumes(this);
  }

  init = async () => {
    await mkdirp([this.opts.mount]);
    await this.initDevice();
    const mountedNow = await this.mountFilesystem();
    // A newly mounted development loopback image benefits from an explicit
    // flush before quota setup. Never put a host-wide filesystem sync on the
    // startup path for an already-mounted production filesystem: active
    // project writeback can make that flush take an unbounded amount of time.
    if (mountedNow) {
      await this.sync();
    }
    // Reconcile the mounted filesystem to CoCalc's only supported quota modes:
    // simple quotas or fully disabled quotas. Classic btrfs qgroups are
    // intentionally unsupported here because they caused severe latency,
    // hangs, and daemon failures under our snapshot-heavy workload. Keep this
    // startup reconciliation so old hosts are forced away from qgroups even if
    // somebody tries to re-enable them via stale config.
    this.quotaRuntime = await ensureBtrfsQuotaModeDetails(this.opts.mount);
    const quotaStatus = this.quotaRuntime.status;
    if (!quotaStatus.enabled) {
      logger.warn("Btrfs quota operations disabled by configuration", {
        mount: this.opts.mount,
      });
    } else {
      logger.info("Btrfs quota mode enabled", {
        mount: this.opts.mount,
        mode: quotaStatus.mode,
      });
      startBtrfsQuotaQueue();
    }
    try {
      await this.initRustic();
    } catch (err) {
      logger.debug(
        "Error starting rustic backup service -- backup not available",
        err,
      );
    }
    if (mountedNow) {
      await this.sync();
    }
    await this.startBees("startup");
    this.startBeesTelemetry();
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
    this.beesGate?.stop();
    this.beesRunningExternally = false;
    if (this.beesRestartTimer) {
      clearTimeout(this.beesRestartTimer);
      this.beesRestartTimer = undefined;
    }
    if (this.beesTelemetryTimer) {
      clearInterval(this.beesTelemetryTimer);
      this.beesTelemetryTimer = undefined;
    }
    if (this.bees) {
      const child = this.bees;
      signalBeesProcessGroup(child, "SIGQUIT");
      const timer = setTimeout(
        () => signalBeesProcessGroup(child, "SIGKILL"),
        1000,
      );
      timer.unref();
    }
  };

  getBeesStatus = () => {
    return {
      enabled: !this.beesDisabledByConfig,
      running:
        !this.beesDisabledByConfig &&
        (this.beesRunningExternally ||
          (this.bees != null &&
            this.bees.killed !== true &&
            this.bees.exitCode == null)),
      pid: this.bees?.pid,
      external: this.beesRunningExternally,
      restartAttempts: this.beesRestartAttempts,
      restartPending: this.beesRestartTimer != null,
      lastExit: this.beesLastExit,
      telemetry: this.beesTelemetry,
      gate: this.beesGate?.getStatus(),
    };
  };

  // One gate for the life of this filesystem; it acts on the BEES cgroup, so
  // it covers a restarted or adopted BEES too.
  private startBeesGate(): void {
    if (this.beesGate || this.beesStopping || !beesGateEnabled()) return;
    this.beesGate = new BeesGate({
      mount: this.opts.mount,
      filesystemUuid: this.quotaRuntime?.filesystem_uuid,
      lifecycleActive: () => this.opts.beesLifecycleActive?.() ?? false,
    });
    void this.beesGate.start();
  }

  private async refreshBeesTelemetry(): Promise<void> {
    if (this.beesTelemetryRunning || this.beesStopping) return;
    this.beesTelemetryRunning = true;
    try {
      const sample = await collectBeesTelemetry(this.opts.mount);
      const previousAssessment = this.beesTelemetry?.assessment;
      this.beesTelemetry = updateBeesTelemetry(this.beesTelemetry, sample);
      if (
        this.beesTelemetry.assessment === "possible_stall" &&
        previousAssessment !== "possible_stall"
      ) {
        logger.warn("BEES telemetry observed possible crawl stall", {
          mount: this.opts.mount,
          telemetry: this.beesTelemetry,
        });
      }
    } catch (err) {
      this.beesTelemetry = recordBeesTelemetryError(this.beesTelemetry, err);
      logger.debug("unable to collect BEES telemetry", {
        mount: this.opts.mount,
        err: `${err}`,
      });
    } finally {
      this.beesTelemetryRunning = false;
    }
  }

  private startBeesTelemetry(): void {
    if (this.beesTelemetryTimer) return;
    void this.refreshBeesTelemetry();
    this.beesTelemetryTimer = setInterval(
      () => void this.refreshBeesTelemetry(),
      beesTelemetryIntervalMs(),
    );
    this.beesTelemetryTimer.unref();
  }

  getQuotaQueueStatus = () => {
    return getBtrfsQuotaQueueStatus(this.opts.mount);
  };

  getQuotaRuntime = (): BtrfsQuotaRuntimeDetails => {
    if (!this.quotaRuntime) {
      throw new Error("Btrfs quota runtime has not been initialized");
    }
    return this.quotaRuntime;
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
    const details = {
      mount: this.opts.mount,
      reason,
      attempt: this.beesRestartAttempts,
      delayMs,
    };
    if (reason === "existing-process-handoff") {
      logger.debug("scheduling BEES restart", details);
    } else {
      logger.warn("scheduling BEES restart", details);
    }
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
    this.beesRunningExternally = false;
    try {
      const result = await bees(this.opts.mount);
      if (result.status === "disabled") {
        this.bees = undefined;
        this.beesDisabledByConfig = true;
        logger.warn("BEES dedup disabled by configuration", {
          mount: this.opts.mount,
          reason,
        });
        // A BEES started by an earlier daemon (e.g. frozen before BEES was
        // turned off) is nobody's now: stop it.
        await applyBeesGateAction(this.opts.mount, "stop").catch((err) =>
          logger.debug("unable to stop a leftover BEES", { err: `${err}` }),
        );
        return;
      }
      if (result.status === "already-running") {
        this.bees = undefined;
        this.beesRunningExternally = true;
        this.beesDisabledByConfig = false;
        this.startBeesGate();
        const details = {
          mount: this.opts.mount,
          reason,
          detail: result.detail,
        };
        if (this.beesRestartAttempts === 0) {
          logger.warn("BEES dedup already running for this mount", details);
        } else {
          logger.debug("BEES dedup already running for this mount", details);
        }
        // A rolling project-host upgrade can briefly overlap the old and new
        // daemons. The old daemon still owns BEES when the new daemon starts,
        // then stops it as shutdown completes. Keep trying to acquire the
        // single-instance wrapper lock so that this handoff cannot leave BEES
        // stopped indefinitely.
        this.scheduleBeesRestart("existing-process-handoff");
        return;
      }
      const { child } = result;
      this.bees = child;
      this.beesDisabledByConfig = false;
      this.beesRestartAttempts = 0;
      logger.info("BEES dedup service running", {
        mount: this.opts.mount,
        pid: child.pid,
        reason,
      });
      this.startBeesGate();
      child.once("exit", (code, signal) => {
        if (this.bees !== child) return;
        this.bees = undefined;
        if (code === BEES_ALREADY_RUNNING_EXIT_CODE) {
          // Older privileged wrappers do not emit the startup handshake. If
          // their process discovery takes longer than our fallback timeout,
          // the ownership refusal can arrive after supervision is attached.
          this.beesRunningExternally = true;
          this.scheduleBeesRestart("existing-process-handoff");
          return;
        }
        this.beesRunningExternally = false;
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

  private mountFilesystem = async (): Promise<boolean> => {
    try {
      await this.info();
      // already mounted
      return false;
    } catch {}
    const { stderr, exit_code } = await this._mountFilesystem();
    if (exit_code) {
      throw Error(stderr);
    }
    return true;
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
