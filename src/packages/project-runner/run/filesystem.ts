import {
  client as createFileClient,
  type Fileserver,
} from "@cocalc/conat/files/file-server";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import {
  sshServer as defaultSshServer,
  projectRunnerMountpoint,
  rusticRepo,
} from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { FILE_SERVER_NAME } from "@cocalc/conat/project/runner/constants";
import { filesystem, type Filesystem } from "@cocalc/file-server/btrfs";

const logger = getLogger("project-runner:filesystem");

let client: ConatClient | null = null;
export function init(opts: { client: ConatClient }) {
  client = opts.client;
}

let fsclient: Fileserver | null = null;
function getFsClient(timeout?: number) {
  if (client == null) {
    throw Error("client not initialized");
  }
  if (!timeout) {
    fsclient ??= createFileClient({ client });
    return fsclient;
  }
  return createFileClient({ client, timeout });
}

export function fileServerClient(opts?: { timeout?: number }) {
  return getFsClient(opts?.timeout);
}

export async function setQuota(project_id: string, size: number | string) {
  const c = getFsClient();
  await c.setQuota({ project_id, size });
}

// default localPath if you don't specify something explicitly when calling
// init in project-runner/run/index.ts
// This is where the fileserver is storing files, and works if projects are
// running on the same compute as the file server, e.g., dev mode.
let fs: Filesystem | null = null;

function volumeName(project_id: string): string {
  return `project-${project_id}`;
}

function scratchVolumeName(project_id: string): string {
  return `${volumeName(project_id)}-scratch`;
}

export async function localPath({
  project_id,
  disk,
  scratch: scratchQuota,
  ensure = true,
}: {
  project_id: string;
  // if given, this quota will be set in case of btrfs
  disk?: number;
  // optional explicit /scratch quota. If omitted on btrfs, we still
  // create /scratch and mirror the main project quota when available.
  // set to 0 to disable /scratch for this call.
  scratch?: number;
  // if false, resolve paths without creating volumes
  ensure?: boolean;
}): Promise<{ home: string; scratch?: string }> {
  logger.debug("localPath: start", {
    project_id,
    ensure,
    disk,
    scratchQuota,
    hasProjectRunnerMountpoint: !!projectRunnerMountpoint,
    hasProjectPathEnv: !!process.env.COCALC_PROJECT_PATH,
  });

  if (projectRunnerMountpoint) {
    logger.debug("localPath: using local btrfs mountpoint", {
      project_id,
      mountpoint: projectRunnerMountpoint,
      ensure,
    });
    fs ??= await filesystem({
      mount: projectRunnerMountpoint,
      rustic: rusticRepo,
    });
    const homeVolName = volumeName(project_id);
    const scratchVolName = scratchVolumeName(project_id);
    const wantsScratch = scratchQuota !== 0;
    logger.debug("localPath: computed volume names", {
      project_id,
      homeVolName,
      scratchVolName,
      wantsScratch,
      scratchDisabled: scratchQuota === 0,
    });
    if (!ensure) {
      const home = join(projectRunnerMountpoint, homeVolName);
      const scratch = wantsScratch
        ? join(projectRunnerMountpoint, scratchVolName)
        : undefined;
      logger.debug("localPath: ensure=false, resolved paths only", {
        project_id,
        home,
        scratch,
      });
      return { home, scratch };
    }

    const homeVol = await fs.subvolumes.ensure(homeVolName);
    if (disk != null) {
      logger.debug("localPath: setting home quota", { project_id, disk });
      await homeVol.quota.set(disk);
    } else {
      logger.debug("localPath: leaving home quota unchanged", { project_id });
    }
    const home = homeVol.path;
    logger.debug("localPath: ensured home volume", { project_id, home });

    let scratch: string | undefined;
    if (wantsScratch) {
      logger.debug("localPath: ensuring scratch volume", {
        project_id,
        scratchVolName,
      });
      const scratchVol = await fs.subvolumes.ensure(scratchVolName);
      let effectiveScratchQuota = scratchQuota ?? disk;
      let scratchQuotaSource: "scratch" | "disk" | "home" | "unset" =
        scratchQuota != null ? "scratch" : disk != null ? "disk" : "unset";
      if (effectiveScratchQuota == null) {
        try {
          const { size } = await homeVol.quota.get();
          if (size != null) {
            effectiveScratchQuota = size;
            scratchQuotaSource = "home";
          }
        } catch (err) {
          // leave scratch quota unchanged if we can't resolve home quota
          logger.warn("localPath: failed to read home quota for scratch", {
            project_id,
            err: `${err}`,
          });
        }
      }
      if (effectiveScratchQuota != null) {
        logger.debug("localPath: setting scratch quota", {
          project_id,
          effectiveScratchQuota,
          scratchQuotaSource,
        });
        await scratchVol.quota.set(effectiveScratchQuota);
      } else {
        logger.debug("localPath: leaving scratch quota unchanged", {
          project_id,
        });
      }
      scratch = scratchVol.path;
      logger.debug("localPath: ensured scratch volume", { project_id, scratch });
    } else {
      logger.debug("localPath: scratch disabled for this call", {
        project_id,
        scratchQuota,
      });
    }
    logger.debug("localPath: done (local btrfs)", { project_id, home, scratch });
    return { home, scratch };
  } else if (process.env.COCALC_PROJECT_PATH) {
    const path = join(process.env.COCALC_PROJECT_PATH, project_id);
    logger.debug("localPath: using COCALC_PROJECT_PATH", {
      project_id,
      path,
      ensure,
    });
    if (ensure) {
      await mkdir(path, { recursive: true });
      logger.debug("localPath: ensured project path directory", {
        project_id,
        path,
      });
    }
    logger.debug("localPath: done (COCALC_PROJECT_PATH)", {
      project_id,
      home: path,
    });
    return { home: path };
  }

  const wantsScratch = scratchQuota !== 0;
  logger.debug("localPath: using remote file server", {
    project_id,
    ensure,
    wantsScratch,
    scratchDisabled: scratchQuota === 0,
  });
  const c = getFsClient();
  if (ensure) {
    logger.debug("localPath: ensuring remote home volume", { project_id });
    await c.ensureVolume({ project_id });
    if (disk != null) {
      logger.debug("localPath: setting remote home quota", { project_id, disk });
      await c.setQuota({ project_id, size: disk });
    } else {
      logger.debug("localPath: leaving remote home quota unchanged", {
        project_id,
      });
    }
    if (wantsScratch) {
      logger.debug("localPath: ensuring remote scratch volume", { project_id });
      await c.ensureVolume({ project_id, scratch: true });
      let effectiveScratchQuota = scratchQuota ?? disk;
      let scratchQuotaSource: "scratch" | "disk" | "home" | "unset" =
        scratchQuota != null ? "scratch" : disk != null ? "disk" : "unset";
      if (effectiveScratchQuota == null) {
        try {
          const { size } = await c.getQuota({ project_id });
          if (size != null) {
            effectiveScratchQuota = size;
            scratchQuotaSource = "home";
          }
        } catch (err) {
          logger.warn("localPath: failed to read remote home quota for scratch", {
            project_id,
            err: `${err}`,
          });
        }
      }
      if (effectiveScratchQuota != null) {
        logger.debug("localPath: setting remote scratch quota", {
          project_id,
          effectiveScratchQuota,
          scratchQuotaSource,
        });
        await c.setQuota({
          project_id,
          size: effectiveScratchQuota,
          scratch: true,
        });
      } else {
        logger.debug("localPath: leaving remote scratch quota unchanged", {
          project_id,
        });
      }
    } else {
      logger.debug("localPath: remote scratch disabled for this call", {
        project_id,
        scratchQuota,
      });
    }
  }
  const { path: home } = await c.mount({ project_id });
  let scratch: string | undefined;
  if (wantsScratch) {
    const mounted = await c.mount({ project_id, scratch: true });
    scratch = mounted.path;
    logger.debug("localPath: resolved remote scratch mount path", {
      project_id,
      scratch,
    });
  }
  logger.debug("localPath: done (remote file server)", {
    project_id,
    home,
    scratch,
  });
  return { home, scratch };
}

// This is the server that we connect to for files and port forwards, which
// runs as part of the file server.
// default sshServer if you don't specify something explicitly when calling
// init in project-runner/run/index.ts
// This is what gets configured with defaults or via the COCALC_SSH_SERVER
// env variable in backend/data.  Again, this is what would work in dev
// mode when everything is on the same computer.
export async function sshServers({ project_id }: { project_id: string }) {
  const { host, port } = defaultSshServer;
  const volume = `project-${project_id}`;
  return [
    {
      name: FILE_SERVER_NAME,
      host,
      port,
      user: `${FILE_SERVER_NAME}-${volume}`,
    },
  ];
}
