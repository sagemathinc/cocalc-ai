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

// The project secret that keys every shared browser's saved sign-ins (see
// cli/src/bin/core/shared-browser/keyring.ts).  A human creates it the first
// time they open a browser; replacing or deleting it signs every browser in
// the project out, including copies in snapshots and backups.
export const SHARED_BROWSER_KEY_SECRET = "COCALC_BROWSER_KEY";

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

// Where a .browser file's browser runs: in the project (bundled headless
// Chromium) or on the user's computer (their Chrome, reached through a
// reverse ssh tunnel from `cocalc project browser connect --browser <file>`).
export type SharedBrowserRunsOn = "project" | "computer";

/** The settings stored in a .browser file (JSON; an empty file is fine). */
export interface SharedBrowserFileSettings {
  runs_on: SharedBrowserRunsOn;
}

export function parseSharedBrowserFile(
  text: string,
): SharedBrowserFileSettings {
  try {
    const value = JSON.parse(text);
    if (value?.runs_on === "computer") return { runs_on: "computer" };
  } catch {
    // Empty or not JSON: the defaults.
  }
  return { runs_on: "project" };
}

export function formatSharedBrowserFile(settings: SharedBrowserFileSettings) {
  return `${JSON.stringify({ runs_on: settings.runs_on }, null, 2)}\n`;
}

/**
 * The project port where a .browser file's browser on the user's computer is
 * reached (the reverse tunnel's end).  Derived from the app id, so `connect`
 * on the computer and the browser service in the project agree without
 * talking to each other.  In 20000..39999, clear of the usual dev ports.
 */
export function sharedBrowserTunnelPort(appId: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(appId)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 20000 + (hash % 20000);
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
