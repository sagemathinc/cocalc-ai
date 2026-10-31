/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

/*
Root installs of runtime artifacts (project-host bundles, project bundles,
tools, container runtime). On hosts whose bootstrap installed the
cocalc-runtime-artifacts helper, the program directories belong to root:
project-host decides what to install, switch to and prune, and root does it
(through cocalc-runtime-storage), downloading only from the software bases
bootstrap configured.
*/

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("project-host:artifact-install");

export const SOFTWARE_SOURCE_PATH = "/etc/cocalc/software-source.json";
export const ARTIFACTS_HELPER_PATH =
  "/usr/local/libexec/cocalc-runtime-artifacts";
const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";
const HELPER_TIMEOUT_MS = 15 * 60_000;

export type RootArtifactKind =
  | "project-host"
  | "project"
  | "tools"
  | "container-runtime";

export interface RootArtifactLayout {
  root: string;
  current: string;
}

export interface RootArtifactConfig {
  bases: string[];
  artifacts: Partial<Record<RootArtifactKind, RootArtifactLayout>>;
}

export async function readRootArtifactConfig({
  configPath = SOFTWARE_SOURCE_PATH,
  helperPath = ARTIFACTS_HELPER_PATH,
}: { configPath?: string; helperPath?: string } = {}): Promise<
  RootArtifactConfig | undefined
> {
  try {
    await access(helperPath);
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    if (!Array.isArray(raw?.bases) || typeof raw?.artifacts !== "object") {
      return undefined;
    }
    return {
      bases: raw.bases.map(String),
      artifacts: raw.artifacts,
    };
  } catch {
    return undefined;
  }
}

// The layout root uses for kind, if root installs it on this host.
export async function rootArtifactLayout(
  kind: RootArtifactKind,
  opts?: { configPath?: string; helperPath?: string },
): Promise<RootArtifactLayout | undefined> {
  const config = await readRootArtifactConfig(opts);
  const layout = config?.artifacts?.[kind];
  if (typeof layout?.root !== "string" || typeof layout?.current !== "string") {
    return undefined;
  }
  return layout;
}

export function rootVersionDir(
  layout: RootArtifactLayout,
  version: string,
): string {
  return join(layout.root, version);
}

export type RunHelper = (args: string[]) => Promise<string>;

function runHelperWithSudo(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "sudo",
      ["-n", STORAGE_WRAPPER, ...args],
      { timeout: HELPER_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) {
          // the helper prints {"status": "refused", "error": ...} and exits 3
          let reason = `${stderr ?? ""}`.trim() || `${err}`;
          try {
            const parsed = JSON.parse(`${stdout ?? ""}`.trim());
            if (parsed?.error) reason = parsed.error;
          } catch {
            // keep stderr
          }
          reject(new Error(`${args[0]} failed: ${reason}`));
          return;
        }
        resolve(`${stdout ?? ""}`);
      },
    );
  });
}

let runHelper: RunHelper = runHelperWithSudo;

// for tests
export function setRunHelperForTests(fn?: RunHelper): void {
  runHelper = fn ?? runHelperWithSudo;
}

async function helper(args: string[]): Promise<Record<string, any>> {
  const out = await runHelper(args);
  try {
    return JSON.parse(out.trim().split("\n").pop() ?? "{}");
  } catch {
    return {};
  }
}

export async function rootInstallArtifact(
  kind: RootArtifactKind,
  version: string,
  baseUrl: string,
): Promise<string> {
  const result = await helper([
    "install-artifact",
    kind,
    version,
    "--base",
    baseUrl.replace(/\/+$/, ""),
  ]);
  logger.info("root installed artifact", { kind, version, ...result });
  return `${result.status ?? ""}`;
}

export async function rootSetCurrentArtifact(
  kind: RootArtifactKind,
  version: string,
  { link = "current" }: { link?: "current" | "previous" } = {},
): Promise<void> {
  await helper(
    link === "current"
      ? ["set-current-artifact", kind, version]
      : ["set-current-artifact", kind, version, "--link", link],
  );
}

// Removes the kind's current link (a failed first activation).
export async function rootClearCurrentArtifact(
  kind: RootArtifactKind,
): Promise<void> {
  await helper(["clear-current-artifact", kind]);
}

// "removed", "absent", or "kept" (current, or in use: root refuses)
export async function rootPruneArtifact(
  kind: RootArtifactKind,
  version: string,
): Promise<"removed" | "absent" | "kept"> {
  try {
    const result = await helper(["prune-artifact", kind, version]);
    return result.status === "absent" ? "absent" : "removed";
  } catch (err) {
    logger.info("root kept artifact version", {
      kind,
      version,
      reason: `${err}`,
    });
    return "kept";
  }
}

// At daemon start: the program roots become root's, and the versions in use
// that root didn't install are installed again from the software base
// (cocalc-runtime-artifacts secure-artifacts). Nothing the runtime user
// installed is made root's in place. One attempt is awaited before artifact
// maintenance starts; a failure is logged and retried. Upgrades don't wait
// for it: they install fresh root-owned versions, which is the remedy.
let secured = false;
let secureError: string | undefined;

export async function secureRootArtifacts(
  baseUrl: string,
  paths?: { configPath?: string; helperPath?: string },
): Promise<boolean> {
  if ((await readRootArtifactConfig(paths)) == null) {
    secured = true; // nothing installed by root on this host
    return true;
  }
  try {
    const result = await helper([
      "secure-artifacts",
      "--base",
      baseUrl.replace(/\/+$/, ""),
    ]);
    logger.info("root secured runtime artifacts", result);
    secured = true;
    secureError = undefined;
    return true;
  } catch (err) {
    secured = false;
    secureError = `${err}`;
    logger.error("unable to secure runtime artifacts; retrying", {
      err: secureError,
    });
    return false;
  }
}

export function rootArtifactsSecured(): { secured: boolean; error?: string } {
  return { secured, error: secureError };
}

export async function startRootArtifactSecuring({
  baseUrl,
  retryMs = 5 * 60_000,
  paths,
}: {
  baseUrl: string;
  retryMs?: number;
  paths?: { configPath?: string; helperPath?: string };
}): Promise<() => void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const attempt = async () => {
    if (stopped) return;
    if (!(await secureRootArtifacts(baseUrl, paths)) && !stopped) {
      timer = setTimeout(() => void attempt(), retryMs);
      timer.unref?.();
    }
  };
  await attempt();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
