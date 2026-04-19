import { conatServer } from "@cocalc/backend/data";
import { join } from "node:path";
import base_path from "@cocalc/backend/base-path";
import { COCALC_SRC, COCALC_BIN, COCALC_BIN2 } from "./mounts";
import getLogger from "@cocalc/backend/logger";
import { inspect } from "./rootfs-base";
import {
  DEFAULT_PROJECT_RUNTIME_GID,
  DEFAULT_PROJECT_RUNTIME_HOME,
  DEFAULT_PROJECT_RUNTIME_UID,
  DEFAULT_PROJECT_RUNTIME_USER,
} from "@cocalc/util/project-runtime";

// where the project places all its data, relative to HOME. This used by ".smc"
export const COCALC_PROJECT_CACHE = ".cache/cocalc/project";

const logger = getLogger("project-runner:run:env");
export const DEFAULT_PROJECT_PROXY_PORT = "18080";

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

export function normalizeProjectContainerConatServer(raw: string): string {
  const trimmed = `${raw ?? ""}`.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (isLoopbackHostname(parsed.hostname)) {
      parsed.hostname = "host.containers.internal";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace("localhost", "host.containers.internal");
  }
}

export function dataPath(HOME: string): string {
  return join(HOME, COCALC_PROJECT_CACHE);
}

// see also packages/project/secret-token.ts
export function secretTokenPath(HOME: string) {
  const data = dataPath(HOME);
  return join(data, "secret-token");
}

async function getImageEnv(image): Promise<{ [key: string]: string }> {
  const { Env } = (await inspect(image)).Config;
  const env: { [key: string]: string } = {};
  try {
    for (const line of Env) {
      const i = line.indexOf("=");
      if (i == -1) continue;
      const key = line.slice(0, i);
      const value = line.slice(i + 1);
      env[key] = value;
    }
  } catch (err) {
    logger.debug(
      "WARNING: unexpected issue parsing image Config.Env",
      { Env },
      err,
    );
  }
  return env;
}

export async function getEnvironment({
  HOME,
  project_id,
  env: extra,
  image,
}: {
  HOME: string;
  project_id: string;
  env?: { [key: string]: string };
  image: string;
}): Promise<{ [key: string]: string }> {
  const extra_env: string = Buffer.from(JSON.stringify(extra ?? {})).toString(
    "base64",
  );

  const imageEnv = await getImageEnv(image);

  const USER = DEFAULT_PROJECT_RUNTIME_USER;
  const DATA = dataPath(HOME);
  // NOTE: we put ${COCALC_SRC}/packages/backend/node_modules/.bin ahead of the system-wide
  // paths, since otherwise, e.g., the 'open' command and other things will get shadowed by
  // system-wide commands with the same name, e.g., after "apt install run-mailcap".
  // This can get tricky though since it means we're always using our own rsync, ssh, etc.
  // Maybe we should divide this into two paths.
  let PATH = `${HOME}/bin:${HOME}/.local/bin:${COCALC_BIN}:${COCALC_BIN2}:${COCALC_SRC}/packages/backend/node_modules/.bin:${imageEnv.PATH ? imageEnv.PATH + ":" : ""}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  const already = new Set<string>();
  const w: string[] = [];
  for (const segment of PATH.split(":")) {
    if (!already.has(segment)) {
      w.push(segment);
      already.add(segment);
    }
  }
  PATH = w.join(":");

  return {
    ...imageEnv,
    TERM: "xterm",
    HOME,
    DATA,
    LOGS: DATA,
    // DEBUG: so interesting stuff gets logged, but not too much unless we really need it.
    DEBUG: "cocalc:*,-cocalc:silly:*",
    DEBUG_CONSOLE: "yes",
    // important to explicitly set the COCALC_ vars since server env has own in a project
    COCALC_PROJECT_ID: project_id,
    COCALC_RUNTIME_BOOTSTRAP: "1",
    COCALC_RUNTIME_USER: DEFAULT_PROJECT_RUNTIME_USER,
    COCALC_RUNTIME_UID: `${DEFAULT_PROJECT_RUNTIME_UID}`,
    COCALC_RUNTIME_GID: `${DEFAULT_PROJECT_RUNTIME_GID}`,
    COCALC_RUNTIME_HOME: DEFAULT_PROJECT_RUNTIME_HOME,
    COCALC_USERNAME: USER,
    USER,
    LOGNAME: USER,
    COCALC_EXTRA_ENV: extra_env,
    PATH,
    // Project containers connect to host-local conat through podman networking.
    // We use host.containers.internal (not a hardcoded IP), and networking mode
    // is selected in run/podman.ts.
    CONAT_SERVER: normalizeProjectContainerConatServer(conatServer),
    COCALC_SECRET_TOKEN: secretTokenPath(HOME),
    BASE_PATH: base_path,
    DEBIAN_FRONTEND: "noninteractive",
    COCALC_PROXY_HOST: "0.0.0.0",
    COCALC_PROXY_PORT: DEFAULT_PROJECT_PROXY_PORT,
  };
}
