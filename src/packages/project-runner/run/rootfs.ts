/*
Privileges: This uses sudo with the root-owned runtime wrapper for overlayfs
mount lifecycle operations only.
*/

import { join } from "path";
import { data } from "@cocalc/backend/data";
import { executeCode } from "@cocalc/backend/execute-code";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { type Configuration } from "@cocalc/conat/project/runner/types";
import { PROJECT_IMAGE_PATH } from "@cocalc/util/db-schema/defaults";
import { getImage } from "./podman";
import {
  extractBaseImage,
  imageCachePath,
  imagePathComponent,
  registerProgress,
} from "./rootfs-base";
import { lroProgress } from "@cocalc/conat/lro/progress";
import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";

import getLogger from "@cocalc/backend/logger";
import { getConatClient } from "./conat-client";

const logger = getLogger("project-runner:overlay");
const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";
const UNMOUNT_DELAY_MS = Number(
  process.env.COCALC_SANDBOX_UNMOUNT_DELAY_MS ?? 30_000,
);
const RECOVERABLE_OVERLAY_MOUNT_PATTERNS = [
  "Stale file handle",
  "failed to verify upper root origin",
] as const;

const PROJECT_ROOTS =
  process.env.COCALC_PROJECT_ROOTS ?? join(data, "cache", "project-roots");

function getMergedPath(project_id) {
  return join(PROJECT_ROOTS, project_id);
}

export function getRootfsMountpoint(project_id: string): string {
  return getMergedPath(project_id);
}

export function getImageNamePath(home): string {
  return join(home, PROJECT_IMAGE_PATH, "current-image.txt");
}

export function getPaths({ home, image, project_id }): {
  lowerdir: string;
  upperdir: string;
  workdir: string;
  merged: string;
  imageName: string;
} {
  const userOverlays = join(
    home,
    PROJECT_IMAGE_PATH,
    imagePathComponent(image),
  );
  const upperdir = join(userOverlays, "upperdir");
  const workdir = join(userOverlays, "workdir");
  const merged = getMergedPath(project_id);
  const lowerdir = imageCachePath(image);
  const imageName = getImageNamePath(home);
  return {
    lowerdir,
    upperdir,
    workdir,
    merged,
    imageName,
  };
}

// Track mount reference counts so multiple users (e.g., project container +
// sandboxExec sidecars) can share the same overlay mount safely.
const leases = new RefcountLeaseManager<string>({
  delayMs: UNMOUNT_DELAY_MS,
  disposer: disposeMount,
});
// Track release functions for each active lease so unmount can drop one ref.
const leaseReleases: Map<
  string,
  Array<(opts?: { immediate?: boolean }) => Promise<void>>
> = new Map();

function addRelease(
  project_id: string,
  release: (opts?: { immediate?: boolean }) => Promise<void>,
) {
  const arr = leaseReleases.get(project_id);
  if (arr) {
    arr.push(release);
  } else {
    leaseReleases.set(project_id, [release]);
  }
}

async function disposeMount(project_id: string): Promise<void> {
  const mountpoint = getMergedPath(project_id);
  try {
    await executeCode({
      verbose: true,
      err_on_exit: true,
      command: "sudo",
      args: ["-n", STORAGE_WRAPPER, "umount-overlay-project", mountpoint],
    });
  } catch (err) {
    const e = `${err}`;
    if (e.includes("not mounted") || e.includes("no mount point")) {
      return;
    }
    logger.warn("unmount failed", { project_id, error: e });
  }
}

// isMounted -- returns true if the overlayfs for this project
// is already mounted.
export async function isMounted({
  project_id,
}: {
  project_id: string;
}): Promise<boolean> {
  const mountpoint = getMergedPath(project_id);
  try {
    const mounts = await readFile("/proc/self/mountinfo", "utf8");
    return mounts.split("\n").some((line) => {
      if (!line) return false;
      const fields = line.split(" ");
      // mountinfo columns: see `man proc`; mountpoint is field 5 (0-based index 4).
      return fields[4] === mountpoint;
    });
  } catch (err) {
    logger.debug("isMounted: failed to read mountinfo", { error: `${err}` });
    return false;
  }
}

// mount the project -- this is idempotent, so can be called even if already mounted.
export async function mount({
  project_id,
  home,
  config,
}: {
  project_id: string;
  home: string;
  config?: Configuration;
}) {
  const release = await leases.acquire(project_id);
  const op_id = config?.lro_op_id;
  const report = (event: {
    type: string;
    progress?: number;
    min?: number;
    max?: number;
    desc?: string;
    error?: unknown;
    elapsed?: number;
    speed?: string;
    eta?: number;
  }) => {
    void lroProgress({
      project_id,
      op_id,
      client: getConatClient(),
      phase: event.type,
      message: event.desc,
      progress: event.progress,
      min: event.min,
      max: event.max,
      error: event.error,
      elapsed: event.elapsed,
      speed: event.speed,
      eta: event.eta,
    });
  };
  try {
    // release will be kept for caller to drop later via unmount.
    report({
      type: "mount-rootfs",
      progress: 0,
      desc: "",
    });

    const image = getImage(config);
    logger.debug("mount", { project_id, home, image });

    registerProgress(image, ({ progress, desc }) => {
      report({
        type: "mount-rootfs",
        progress,
        max: 70,
        desc,
      });
    });

    // uses the above registerProgress
    const lowerdir = await extractBaseImage(image);

    report({
      type: "mount-rootfs",
      progress: 70,
      desc: "extracted base image",
    });
    const { upperdir, workdir, merged, imageName } = getPaths({
      home,
      image,
      project_id,
    });

    // If a delayed unmount was pending, cancel it because we're reusing the mount.
    // (handled by RefcountLeaseManager internally)

    if (await isMounted({ project_id })) {
      // Already mounted; keep the lease and return.
      addRelease(project_id, release);
      return merged;
    }

    try {
      // workdir must be empty when mount happens -- it is scratch space
      await rm(workdir, { recursive: true, force: true });
    } catch {}
    await mkdir(upperdir, { recursive: true });
    await mkdir(workdir, { recursive: true });
    await mkdir(merged, { recursive: true });

    // Persist image info for later lookup (e.g., ephemeral exec when the container is stopped).
    await writeFile(imageName, image);

    report({
      type: "mount-rootfs",
      progress: 80,
      desc: "created directories",
    });
    await mountOverlayFs({ lowerdir, upperdir, workdir, merged });
    report({
      type: "mount-rootfs",
      progress: 100,
      desc: "mounted",
    });

    // Successful mount keeps the lease alive; caller now owns one ref.
    addRelease(project_id, release);
    return merged;
  } catch (err) {
    // If something failed, drop the lease immediately.
    await release();
    throw err;
  }
}

export async function unmount(
  project_id: string,
  opts?: { immediate?: boolean },
) {
  const arr = leaseReleases.get(project_id);
  const release = arr?.pop();
  if (release == null) return;
  if (arr?.length === 0) {
    leaseReleases.delete(project_id);
  }
  await release(opts);
}

export async function unmountAll(project_id: string): Promise<void> {
  const releases = leaseReleases.get(project_id) ?? [];
  leaseReleases.delete(project_id);
  for (const release of releases.reverse()) {
    await release({ immediate: true });
  }
  if (await isMounted({ project_id })) {
    await disposeMount(project_id);
  }
}

async function mountOverlayFs({ upperdir, workdir, merged, lowerdir }) {
  try {
    await executeCode({
      verbose: true,
      err_on_exit: true,
      command: "sudo",
      args: [
        "-n",
        STORAGE_WRAPPER,
        "mount-overlay-project",
        // CRITICAL: wrapper hardcodes the xattr-capable overlay options. Project
        // backup and restore now preserve trusted.overlay.* metadata via the
        // dedicated privileged rustic wrapper path.
        lowerdir,
        upperdir,
        workdir,
        merged,
      ],
    });
  } catch (err) {
    if (!isRecoverableOverlayMountError(err)) {
      throw err;
    }
    logger.warn("mountOverlayFs: detected stale overlay upperdir", {
      merged,
      lowerdir,
      upperdir,
      workdir,
      error: `${err}`,
    });
    throw new Error(
      `project RootFS overlay is incompatible with the current cached base image. ` +
        `To recover, delete the project overlay directories and start the project again:\n` +
        `  upperdir: ${upperdir}\n` +
        `  workdir: ${workdir}\n` +
        `Original mount error: ${err}`,
    );
  }
}

function isRecoverableOverlayMountError(err: unknown): boolean {
  const text = `${err}`;
  return RECOVERABLE_OVERLAY_MOUNT_PATTERNS.some((pattern) =>
    text.includes(pattern),
  );
}
