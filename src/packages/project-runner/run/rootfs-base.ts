import { join } from "node:path";
import { data } from "@cocalc/backend/data";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import { executeCode } from "@cocalc/backend/execute-code";
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "fs/promises";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { isManagedRootfsImageName } from "@cocalc/util/rootfs-images";
import pullImage from "./pull-image";
import {
  loadRootfsPreflightMetadata,
  preflightPulledOciImage,
  preflightRootfsInPlace,
  requireCurrentRootfsPreflightMetadata,
  writeRootfsPreflightMetadata,
} from "./rootfs-normalize";
import { shiftProgress } from "@cocalc/conat/lro/progress";
import { PROGRESS_ARGS, rsyncProgressReporter } from "./rsync-progress";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("project-runner:rootfs-base");
const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";

export const IMAGE_CACHE =
  process.env.COCALC_IMAGE_CACHE ?? join(data, "cache", "images");
const ROOTFS_PULL_TMPDIR =
  process.env.COCALC_ROOTFS_PULL_TMPDIR ?? join(data, "tmp");

export function imagePathComponent(image: string): string {
  // overlayfs option parsing can break on ":" inside paths; use an encoded
  // path component for all on-disk image directories.
  return encodeURIComponent(image);
}

export function imageCachePath(image: string): string {
  return join(IMAGE_CACHE, imagePathComponent(image));
}

type ProgressFunction = (opts: { progress: number; desc: string }) => void;

function progressFromPreflightMessage(message: string): number {
  const normalized = `${message}`.trim().toLowerCase();
  if (normalized.includes("checking rootfs preflight prerequisites")) {
    return 92;
  }
  if (normalized.includes("validated rootfs bootstrap prerequisites")) {
    return 98;
  }
  return 96;
}

// This is a bit complicated because extractBaseImage uses reuseInFlight,
// and it's actually very likely MULTIPLE projects will start and need
// to extract an image at the same time, so they should all see the progress
// updates together.
const progressWatchers: { [image: string]: ProgressFunction[] } = {};
export function registerProgress(image: string, f: ProgressFunction) {
  if (progressWatchers[image] == null) {
    progressWatchers[image] = [f];
  } else {
    progressWatchers[image].push(f);
  }
}

export function inspectFilePath(image: string): string {
  return join(IMAGE_CACHE, `.${imagePathComponent(image)}.json`);
}

export function preflightMetadataFilePath(image: string): string {
  return join(IMAGE_CACHE, `.${imagePathComponent(image)}.normalized.json`);
}

export const normalizationFilePath = preflightMetadataFilePath;

export async function cleanupImageCacheArtifact(path: string): Promise<void> {
  if (!(await exists(path))) return;
  try {
    await rm(path, {
      force: true,
      recursive: true,
      maxRetries: 3,
    });
    return;
  } catch (err) {
    logger.warn("regular cached image cleanup failed; retrying with wrapper", {
      path,
      err: `${err}`,
    });
  }
  await executeCode({
    command: "sudo",
    args: ["-n", STORAGE_WRAPPER, "rm", "-rf", path],
    err_on_exit: true,
    verbose: false,
  });
}

async function cleanupImageCacheArtifacts(paths: string[]): Promise<void> {
  for (const path of paths) {
    await cleanupImageCacheArtifact(path);
  }
}

// this should error if the image isn't available and extracted.  I.e., it should always
// be either very fast or throw an error.  Clients that use it should make sure to do
// extractBaseImage before using this.  The reason is to ensure that users have visibility
// into all long running steps.
export async function inspect(image: string) {
  return JSON.parse(await readFile(inspectFilePath(image), "utf8"));
}

export const extractBaseImage = reuseInFlight(async (image: string) => {
  logger.debug("extractBaseImage", { image });
  const reportProgress = (x: {
    progress: number;
    desc: string;
    speed?;
    eta?;
    min?: number;
    max?: number;
  }) => {
    x.progress = shiftProgress(x);
    for (const f of progressWatchers[image] ?? []) {
      f(x);
    }
  };

  try {
    const baseImagePath = imageCachePath(image);
    const preflightPath = preflightMetadataFilePath(image);
    const inspectPath = inspectFilePath(image);
    reportProgress({ progress: 0, desc: `checking for ${image}...` });
    if ((await exists(inspectPath)) && (await exists(baseImagePath))) {
      try {
        requireCurrentRootfsPreflightMetadata({
          image,
          metadataPath: preflightPath,
          metadata: await loadRootfsPreflightMetadata(preflightPath),
        });
      } catch (err) {
        if (isManagedRootfsImageName(image)) {
          throw err;
        }
        reportProgress({
          progress: 2,
          desc: `refreshing stale cached ${image}...`,
        });
        await cleanupImageCacheArtifacts([
          baseImagePath,
          inspectPath,
          preflightPath,
        ]);
      }
    }
    if ((await exists(inspectPath)) && (await exists(baseImagePath))) {
      reportProgress({ progress: 100, desc: `${image} available` });
      return baseImagePath;
    }
    if (
      !isManagedRootfsImageName(image) &&
      ((await exists(baseImagePath)) ||
        (await exists(inspectPath)) ||
        (await exists(preflightPath)))
    ) {
      reportProgress({
        progress: 2,
        desc: `cleaning incomplete cached ${image}...`,
      });
      await cleanupImageCacheArtifacts([
        baseImagePath,
        inspectPath,
        preflightPath,
      ]);
    }
    if (isManagedRootfsImageName(image)) {
      reportProgress({
        progress: 100,
        desc: `${image} is not cached on this host`,
      });
      throw new Error(
        `managed RootFS image '${image}' is not cached on this host yet`,
      );
    }
    reportProgress({ progress: 5, desc: `pulling ${image}...` });
    // pull it -- this takes most of the time.
    // It is also important to do this before the unshare below,
    // since doing it inside the unshare hits namespace issues.
    try {
      await pullImage({
        image,
        reportProgress: ({ progress, desc }) => {
          reportProgress({ progress, desc, min: 5, max: 55 });
        },
        timeout: 30 * 60 * 1000, // 30 minutes
        // Large scientific images can contain uid/gid values outside
        // the host's configured subuid/subgid ranges. Allow Podman to
        // ignore those during pull; we reconcile ownership later during
        // host-side RootFS preflight and bootstrap.
        storageOptIgnoreChownErrors: true,
        env: { TMPDIR: ROOTFS_PULL_TMPDIR },
      });
    } catch (err) {
      reportProgress({ progress: 100, desc: `pulling ${image} failed` });
      throw err;
    }

    try {
      await preflightPulledOciImage({
        image,
        onProgress: ({ message }) => {
          reportProgress({
            progress: message.includes("validated") ? 58 : 56,
            desc: `${message} (${image})`,
          });
        },
      });

      reportProgress({
        progress: 59,
        desc: `collecting OCI image metadata for ${image}...`,
      });
      const { stdout: inspect } = await executeCode({
        err_on_exit: true,
        verbose: true,
        command: "podman",
        args: ["image", "inspect", image, "--format", "{{json .}}"],
      });

      reportProgress({ progress: 60, desc: `extracting ${image}...` });

      // TODO: an optimization on COW filesystem if we pull one image
      // then pull another with a different tag, would be to start by
      // initializing the target path using COW, then 'rsync ... --delete'
      // to transform it to the result.  This could MASSIVELY save space.

      // extract the image
      const args = [
        "unshare",
        "bash",
        "-c",
        `
  set -ev
  mnt="$(podman image mount ${image})"
  echo "mounted at: $mnt"
  mkdir -p "${baseImagePath}"
  rsync -aHx ${PROGRESS_ARGS.join(" ")} --numeric-ids --delete "$mnt"/ "${baseImagePath}"/
  podman image unmount ${image}
`,
      ];
      logger.debug(`extracting ${image}...`);
      const child = spawn("podman", args);
      await rsyncProgressReporter({
        child,
        progress: ({ progress, speed, eta }) => {
          reportProgress({
            min: 60,
            max: 90,
            progress,
            speed,
            eta,
            desc: `extracting ${image}...`,
          });
        },
      });

      reportProgress({
        progress: 90,
        desc: `cleaning up ${image}...`,
      });
      const preflight = await preflightRootfsInPlace({
        image,
        rootfsPath: baseImagePath,
        ownershipSource: "oci-extract",
        onProgress: ({ message }) => {
          reportProgress({
            progress: progressFromPreflightMessage(message),
            desc: `${message} (${image})`,
          });
        },
      });

      // success -- write out "podman image inspect" in json format to:
      //   (1) signal success, and (2) it is useful for getting information about
      // the image (environment, sha256, etc.), without having to download it again.
      await writeFile(inspectFilePath(image), inspect);
      await writeRootfsPreflightMetadata({
        metadataPath: preflightPath,
        metadata: preflight,
      });
      // remove the image to save space, in case it isn't used by
      // anything else.  we will not need it again, since we already
      // have a copy of it.
      await executeCode({ command: "podman", args: ["image", "rm", image] });
      reportProgress({ progress: 100, desc: `pulled and extracted ${image}` });
      return baseImagePath;
    } catch (err) {
      reportProgress({
        progress: 90,
        desc: `cleaning up failed ${image}...`,
      });
      try {
        await cleanupImageCacheArtifacts([
          baseImagePath,
          inspectPath,
          preflightPath,
        ]);
        await executeCode({ command: "podman", args: ["image", "rm", image] });
      } catch {}
      reportProgress({
        progress: 100,
        desc: `preflighting ${image} failed`,
      });
      throw err;
    }
  } finally {
    delete progressWatchers[image];
  }
});
