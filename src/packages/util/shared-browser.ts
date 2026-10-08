/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The shared browser (`cocalc project browser`) runs as a project app.  The
project's own browser (the one chat cards show) is the app "cocalc-browser";
each `.browser` file has its own browser, an app whose id is derived from the
file's absolute path.  The CLI and the `.browser` editor both use these, so
they always agree on which app a file means.
*/

export const SHARED_BROWSER_APP_ID = "cocalc-browser";

export const SHARED_BROWSER_FILE_APP_ID_RE = /^cocalc-browser-[0-9a-f]{16}$/;

// 64 bits of hash: FNV-1a over the UTF-8 bytes, twice with different seeds.
function fnv1a32(bytes: Uint8Array, seed: number): string {
  let hash = seed >>> 0;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The app id of the browser of the `.browser` file at this absolute path. */
export function sharedBrowserFileAppId(absolutePath: string): string {
  const bytes = new TextEncoder().encode(absolutePath);
  return `${SHARED_BROWSER_APP_ID}-${fnv1a32(bytes, 0x811c9dc5)}${fnv1a32(bytes, 0x050c5d1f)}`;
}

export function sharedBrowserTitle(absolutePath?: string | null): string {
  if (!absolutePath) return "Shared browser";
  return `Browser: ${absolutePath.split("/").pop() || absolutePath}`;
}

/**
 * The project app running `serve`.  `exec`/`args` run the CoCalc CLI;
 * `serve` itself needs no credentials.
 */
export function sharedBrowserAppSpec({
  exec,
  args,
  appId = SHARED_BROWSER_APP_ID,
  file = null,
}: {
  exec: string;
  args: string[];
  appId?: string;
  file?: string | null;
}) {
  return {
    version: 1 as const,
    id: appId,
    title: sharedBrowserTitle(file),
    kind: "service" as const,
    command: {
      exec,
      args: [
        ...args,
        "project",
        "browser",
        "serve",
        ...(file ? ["--browser", file] : []),
      ],
    },
    lifecycle: { mode: "managed" as const },
    network: { listen_host: "127.0.0.1", protocol: "http" as const },
    proxy: {
      base_path: `/apps/${appId}`,
      strip_prefix: true,
      websocket: true,
      open_mode: "proxy" as const,
      health_path: "/healthz",
      readiness_timeout_s: 30,
    },
    wake: { enabled: true, keep_warm_s: 30 * 60, startup_timeout_s: 45 },
  };
}
