/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Trust-free step 6, phase 7: apps open on their own origins (via the hub's
// /app-open), never on the project host's origin, whose cookie opens every
// project of the visitor on that host.  These are the only files that may
// still build host-origin app URLs; each is a fallback for sites without app
// origins, or a framed use that moves with the frame bootstrap (D7).  A new
// caller must use appOpenURL or be added here with a reason.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
const ALLOWED = new Set([
  "conat/client.ts", // defines addProjectHostAuthToUrl
  "project/host-url.ts", // defines withProjectHostBase
  "project/app-server-open.ts", // fallback without app origins
  "project/apps/app-state.tsx", // fallback without app origins
  "project/named-server-panel.tsx", // fallback without app origins
  "project/redux/actions.ts", // fallback without app origins
  "chat/app-artifact.tsx", // framed via useAppFrameSrc (host URL only without app origins)
  "frame-editors/x11-editor/blit.tsx", // framed via useAppFrameSrc (host URL only without app origins)
]);
const PATTERN =
  /addProjectHostAuthToUrl|withProjectHostBase\(|getProjectAppOpenUrl\(/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
      yield path;
  }
}

describe("host-origin app URLs", () => {
  it("are built only by the known fallbacks and framed uses", () => {
    const found: string[] = [];
    for (const path of sources(ROOT)) {
      if (PATTERN.test(readFileSync(path, "utf8"))) {
        found.push(relative(ROOT, path));
      }
    }
    expect(found.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });
});
