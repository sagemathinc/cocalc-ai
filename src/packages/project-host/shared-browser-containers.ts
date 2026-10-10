/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A project's shared browsers each run in a container of their own, next to
the project's, so a site that breaks into Chromium gets neither the
project's files nor its network (unless the project asks for that) nor the
host.  The project's `cocalc project browser serve` asks for its container
here, as the project; everything about the container is decided here, from
host-managed paths only (never a path inside the project, which the project
could swap for a symlink just before it is mounted).

The container:
- the project's own root filesystem, read-only, and CoCalc's tools
  read-only (Chromium, node, the CLI, whose `container-entry` it runs);
- SHARED_BROWSER_RUN_DIR: the directory it shares with the project (the
  DevTools socket it serves, the keyring socket the project serves);
- /profiles: the project's browser profiles, on the host, never in the
  project (so not in its snapshots or backups);
- Chromium's own sandbox: all capabilities dropped except SYS_CHROOT
  (inside the rootless user namespace), no new privileges;
- its own network namespace, in the project's cgroup pool, so the project's
  network policy applies to it; or, when asked (and always for a project
  without internet), the project's network.
*/

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { extractProjectSubject } from "@cocalc/conat/auth/subject-policy";
import type { Client } from "@cocalc/conat/core/client";
import getLogger from "@cocalc/backend/logger";
import { data } from "@cocalc/backend/data";
import { mountArg, podman } from "@cocalc/backend/podman";
import { localPath } from "@cocalc/project-runner/run/filesystem";
import { getCoCalcMounts } from "@cocalc/project-runner/run/mounts";
import {
  networkArgument,
  podmanRuntimeArgs,
  projectBrowserRunHostPath,
  projectPoolPodmanLauncher,
  verifyProjectContainerInPool,
} from "@cocalc/project-runner/run/podman";
import {
  getImageNamePath,
  mount as mountRootFs,
  unmount as unmountRootFs,
} from "@cocalc/project-runner/run/rootfs";
import {
  DEFAULT_PROJECT_RUNTIME_GID,
  DEFAULT_PROJECT_RUNTIME_UID,
} from "@cocalc/util/project-runtime";
import {
  isSharedBrowserAppId,
  SHARED_BROWSER_APP_ID,
  SHARED_BROWSER_RUN_DIR,
  sharedBrowserContainerName,
} from "@cocalc/util/shared-browser";
import { readFile } from "node:fs/promises";

import { projectNetworkPolicyFromRunQuota } from "./network-policy";
import { getProject } from "./sqlite/projects";

const logger = getLogger("project-host:shared-browser-containers");

export const SHARED_BROWSER_SUBJECT = "project.*.shared-browser.-";

const MAX_BROWSERS_PER_PROJECT = 4;
const PROFILES_TARGET = "/profiles";
const NODE = "/opt/cocalc/bin/node";
const CLI = "/opt/cocalc/bin2/cocalc-cli.js";

export type SharedBrowserNetwork = "own" | "project";

export interface SharedBrowserStartRequest {
  appId: string;
  // "project": the project's network (its localhost servers); always so for
  // a project without internet access.
  network?: SharedBrowserNetwork;
  // The project's browser key fingerprint: sign-ins are kept only with it.
  keyFingerprint?: string | null;
  // Pages to reopen.
  urls?: string[];
}

export interface SharedBrowserContainerInfo {
  name: string;
  network: SharedBrowserNetwork;
  // The DevTools socket, as the project sees it.
  socket: string;
}

export function sharedBrowserProfilesHostPath(project_id: string): string {
  return join(data, "shared-browser-profiles", project_id);
}

// One lease on the project's rootfs per running browser container.
const rootfsLeases = new Set<string>();

function projectOf(context: { subject?: string } | undefined): string {
  const project_id = extractProjectSubject(`${context?.subject ?? ""}`);
  if (!project_id) throw Error("not a project subject");
  return project_id;
}

export function validateStartRequest(
  request: SharedBrowserStartRequest,
): Required<Omit<SharedBrowserStartRequest, "keyFingerprint">> & {
  keyFingerprint: string | null;
} {
  const appId = `${request?.appId ?? ""}`;
  if (!isSharedBrowserAppId(appId)) throw Error("invalid shared browser id");
  const network = request?.network === "project" ? "project" : "own";
  const keyFingerprint =
    request?.keyFingerprint == null ? null : `${request.keyFingerprint}`;
  if (keyFingerprint != null && !/^[0-9a-f]{8,128}$/.test(keyFingerprint))
    throw Error("invalid key fingerprint");
  const urls = (Array.isArray(request?.urls) ? request.urls : [])
    .map((url) => `${url}`)
    .filter((url) => /^https?:\/\/[^\s]{1,2000}$/.test(url))
    .slice(0, 20);
  return { appId, network, keyFingerprint, urls };
}

async function runningBrowserContainers(project_id: string): Promise<string[]> {
  const prefix = sharedBrowserContainerName(project_id, SHARED_BROWSER_APP_ID);
  const { stdout } = await podman(
    ["ps", "--format", "{{.Names}}", "--filter", `name=^${prefix}`],
    { timeout: 30 },
  );
  return `${stdout ?? ""}`
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name === prefix || name.startsWith(`${prefix}-`));
}

async function containerLabel(
  name: string,
  label: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await podman(
      ["inspect", "--format", `{{index .Config.Labels "${label}"}}`, name],
      { timeout: 30 },
    );
    return `${stdout ?? ""}`.trim();
  } catch {
    return undefined;
  }
}

async function removeContainer(project_id: string, name: string) {
  await podman(["rm", "-f", "-t", "5", name], { timeout: 60 }).catch(() => {});
  if (rootfsLeases.delete(name))
    await unmountRootFs(project_id).catch((err) =>
      logger.warn("rootfs release failed", { project_id, err: `${err}` }),
    );
}

export async function startSharedBrowserContainer(
  project_id: string,
  request: SharedBrowserStartRequest,
): Promise<SharedBrowserContainerInfo> {
  const { appId, keyFingerprint, urls, ...rest } =
    validateStartRequest(request);
  const runRoot = projectBrowserRunHostPath(project_id);
  if (!existsSync(runRoot))
    throw Error(
      "this project started before its host could give browsers their own containers: restart the project",
    );
  // A project without internet access: the browser reaches only what the
  // project does.
  const network: SharedBrowserNetwork =
    projectNetworkPolicyFromRunQuota(getProject(project_id)?.run_quota) ===
    "normal"
      ? rest.network
      : "project";
  const name = sharedBrowserContainerName(project_id, appId);
  const socket = `${SHARED_BROWSER_RUN_DIR}/${appId}/cdp.sock`;
  const running = await runningBrowserContainers(project_id);
  if (running.includes(name)) {
    const same =
      (await containerLabel(name, "cocalc.browser.network")) === network &&
      (await containerLabel(name, "cocalc.browser.key")) ===
        (keyFingerprint ?? "");
    if (same) return { name, network, socket };
    await removeContainer(project_id, name);
  } else if (running.length >= MAX_BROWSERS_PER_PROJECT) {
    throw Error(
      `a project runs at most ${MAX_BROWSERS_PER_PROJECT} browsers at once`,
    );
  } else {
    // A stopped one of the same name.
    await podman(["rm", "-f", name], { timeout: 30 }).catch(() => {});
  }

  const { home } = await localPath({ project_id, ensure: false });
  const image = (await readFile(getImageNamePath(home), "utf8")).trim();
  const rootfs = await mountRootFs({ project_id, home, config: { image } });
  rootfsLeases.add(name);
  const profiles = sharedBrowserProfilesHostPath(project_id);
  await mkdir(profiles, { recursive: true, mode: 0o700 });

  const args: string[] = [
    "run",
    ...(await podmanRuntimeArgs()),
    "--cgroups=disabled",
    "--detach",
    "--rm",
    `--userns=keep-id:uid=${DEFAULT_PROJECT_RUNTIME_UID},gid=${DEFAULT_PROJECT_RUNTIME_GID}`,
    "--user",
    `${DEFAULT_PROJECT_RUNTIME_UID}:${DEFAULT_PROJECT_RUNTIME_GID}`,
    network === "project"
      ? `--network=container:project-${project_id}`
      : networkArgument(),
    "--name",
    name,
    "--label",
    `cocalc.browser.network=${network}`,
    "--label",
    `cocalc.browser.key=${keyFingerprint ?? ""}`,
    // Chromium's own sandbox needs to chroot in its namespaces.  And CoCalc's
    // node may carry cap_net_bind_service (the host's, to serve port 443):
    // exec fails without it in the bounding set.  Both only within this
    // container's rootless user namespace and network.
    "--cap-drop=all",
    "--cap-add=SYS_CHROOT",
    "--cap-add=NET_BIND_SERVICE",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=1g,mode=1777",
    "--tmpfs",
    "/dev/shm:rw,size=512m",
    "--pids-limit",
    "2048",
    "-e",
    "HOME=/tmp",
    "-e",
    "PATH=/usr/local/bin:/usr/bin:/bin",
  ];
  if (network === "own") args.push("--hostname", "browser");
  const mounts = getCoCalcMounts();
  for (const source in mounts)
    if (existsSync(source))
      args.push(mountArg({ source, target: mounts[source], readOnly: true }));
  args.push(mountArg({ source: runRoot, target: SHARED_BROWSER_RUN_DIR }));
  args.push(mountArg({ source: profiles, target: PROFILES_TARGET }));
  args.push("--rootfs", rootfs);
  args.push(
    NODE,
    CLI,
    "project",
    "browser",
    "container-entry",
    "--run-dir",
    `${SHARED_BROWSER_RUN_DIR}/${appId}`,
  );
  if (keyFingerprint)
    args.push(
      "--profile-dir",
      `${PROFILES_TARGET}/${appId}`,
      "--key-fingerprint",
      keyFingerprint,
    );
  if (urls.length > 0) args.push("--url", ...urls);

  logger.debug("starting browser container", {
    project_id,
    name,
    network,
    kept: !!keyFingerprint,
  });
  try {
    await podman(args, {
      launcher: projectPoolPodmanLauncher(project_id),
      timeout: 120,
    });
    await verifyProjectContainerInPool({ project_id, name });
  } catch (err) {
    await removeContainer(project_id, name);
    throw err;
  }
  return { name, network, socket };
}

export async function stopSharedBrowserContainer(
  project_id: string,
  appId: string,
): Promise<void> {
  if (!isSharedBrowserAppId(appId)) throw Error("invalid shared browser id");
  await removeContainer(
    project_id,
    sharedBrowserContainerName(project_id, appId),
  );
}

export async function initSharedBrowserService(client: Client) {
  logger.debug("starting shared browser service", {
    subject: SHARED_BROWSER_SUBJECT,
  });
  return await client.service(SHARED_BROWSER_SUBJECT, {
    async start(
      this: { subject?: string },
      request: SharedBrowserStartRequest,
    ): Promise<SharedBrowserContainerInfo> {
      return await startSharedBrowserContainer(projectOf(this), request);
    },
    async stop(this: { subject?: string }, appId: string): Promise<null> {
      await stopSharedBrowserContainer(projectOf(this), `${appId ?? ""}`);
      return null;
    },
  });
}
