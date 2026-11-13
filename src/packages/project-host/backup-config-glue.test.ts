/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// file-server.ts and master.ts can't be loaded under jest (ESM-only
// dependencies), so their two lines between BackupConfigs and the hub are
// pinned here as text: the invalidation result passes through file-server.ts
// unchanged, and master.ts answers the hub only through
// invalidateBackupConfigReply (tested in backup-profile.test.ts). Neither
// may decide a profile outcome of its own.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (name: string) => readFileSync(join(__dirname, name), "utf8");
const fileServer = read("file-server.ts");
const master = read("master.ts");

const PROFILE_LITERAL = /["'`](removed|absent|failed|unconfirmed)["'`]/g;

function exported(text: string, name: string): string {
  const start = text.search(
    new RegExp(`^export async function ${name}\\b`, "m"),
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end + 2);
}

it("file-server.ts passes the invalidation result through unchanged", () => {
  const body = exported(fileServer, "invalidateBackupConfig");
  expect(body).toMatch(
    /\}> \{\s*return await backupConfigs\.invalidate\(project_id\);\s*\}$/,
  );
  expect(fileServer.match(/new BackupConfigs\(/g)).toHaveLength(1);
  expect(fileServer).not.toMatch(/new BackupProfiles\(/);
  expect(fileServer).not.toMatch(/removeBackupProfile/);
});

it("master.ts answers the hub only through invalidateBackupConfigReply", () => {
  const start = master.indexOf(
    "async invalidateBackupConfig({ project_id } = {}) {",
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const method = master.slice(start, master.indexOf("\n    },", start) + 7);
  expect(method).toMatch(
    /\{\s*return invalidateBackupConfigReply\(\s*await invalidateBackupConfig\(project_id\),?\s*\);\s*\},$/,
  );
});

it("neither file names a profile outcome of its own", () => {
  expect(
    exported(fileServer, "invalidateBackupConfig").match(PROFILE_LITERAL),
  ).toEqual(['"removed"', '"absent"', '"failed"']); // its return type only
  expect(master.match(PROFILE_LITERAL)).toBeNull();
});
