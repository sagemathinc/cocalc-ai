import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { root } from "@cocalc/backend/data";

// default - it gets changed to something *inside* the container when getCocalcMounts() is called
export let nodePath = process.execPath;

export const COCALC_BIN = "/opt/cocalc/bin";
export const COCALC_BIN2 = "/opt/cocalc/bin2";
export const COCALC_LIB = "/opt/cocalc/lib";
export const COCALC_SRC = "/opt/cocalc/src";
export const DEFAULT_PROJECT_TOOLS = "/opt/cocalc/tools/current";
export const PROJECT_BUNDLE_MOUNT_POINT = "/opt/cocalc/project-bundle";
export const PROJECT_BUNDLE_BIN_PATH = join(PROJECT_BUNDLE_MOUNT_POINT, "bin");
export const PROJECT_BUNDLES_MOUNT_POINT = "/opt/cocalc/project-bundles";
export const PROJECT_BUNDLES_CURRENT_BIN_PATH = join(
  PROJECT_BUNDLES_MOUNT_POINT,
  "current",
  "bin",
);

export function projectBundleBinPathPrefix(): string {
  return `${PROJECT_BUNDLES_CURRENT_BIN_PATH}:${PROJECT_BUNDLE_BIN_PATH}`;
}

export function getNodeRuntimeMounts(
  nodeExecPath = process.execPath,
  pathExists: (path: string) => boolean = existsSync,
) {
  const binDir = dirname(nodeExecPath);
  const mounts: Record<string, string> = {
    [binDir]: COCALC_BIN,
  };
  const libDir = join(dirname(binDir), "lib");
  if (pathExists(libDir)) {
    mounts[libDir] = COCALC_LIB;
  }
  return mounts;
}

export function getCoCalcMounts(
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
) {
  // NODEJS_SEA_PATH is where we mount the directory containing the nodejs SEA binary,
  // which we *also* use for running the project itself.
  // Also, we assume that there is "node" here, e.g., this could be a symlink to
  // the cocalc-project-runner binary, or it could just be the normal node binary.
  nodePath = join(COCALC_BIN, "node");

  const mounts: Record<string, string> = {
    // COCALC_SRC is where the project's Javascript code is located, which is what the project
    // container runs at startup.
    [join(dirname(root), "src")]: COCALC_SRC,
    ...getNodeRuntimeMounts(),
  };

  const tools = env.COCALC_PROJECT_TOOLS ?? DEFAULT_PROJECT_TOOLS;
  if (tools && pathExists(tools)) {
    mounts[tools] = COCALC_BIN2;
    return mounts;
  }

  if (env.COCALC_PROJECT_BUNDLE) {
    // Legacy layout: bundle contains src/ and bin/ directories.
    mounts[join(env.COCALC_PROJECT_BUNDLE, "src")] = COCALC_SRC;
    mounts[join(env.COCALC_PROJECT_BUNDLE, "bin")] = COCALC_BIN2;
    return mounts;
  }

  // IMPORTANT: take care not to put the binary next to sensitive info due
  // to mapping in process.execPath!
  return mounts;
}
