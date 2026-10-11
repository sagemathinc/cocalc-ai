/*
 *  This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { initContext } from "./context";
import { projectDisplayPath } from "./util";

const project_id = "4994aad8-4ee4-440f-bfca-07aca5211ff0";
const other = "00000000-1000-4000-8000-000000000000";

initContext({
  sqlite: { DatabaseSync: class {} as any },
  compress: (b: Buffer) => b,
  decompress: (b: Buffer) => b,
  syncFiles: {
    local: "/mnt/cocalc/data/sync",
    localProjects:
      "/mnt/cocalc/project-[project_id]/.local/share/cocalc/persist",
    localAccounts: "",
    localHosts: "",
    localHub: "",
    archive: "",
    archiveInterval: 30_000,
    backup: "",
  },
  ensureContainingDirectoryExists: async () => {},
  statSync: () => ({ mtimeMs: 0 }),
  copyFileSync: () => {},
});

describe("projectDisplayPath", () => {
  it("shows a project's persist file as the project's user sees it", () => {
    expect(
      projectDisplayPath(
        `projects/${project_id}/patchflow/home/user/a.ipynb`,
        `/mnt/cocalc/project-${project_id}/.local/share/cocalc/persist/patchflow/home/user/a.ipynb.db.oversized-2026`,
      ),
    ).toBe(
      "~/.local/share/cocalc/persist/patchflow/home/user/a.ipynb.db.oversized-2026",
    );
  });

  it("never returns a host path", () => {
    // another project's directory
    expect(
      projectDisplayPath(
        `projects/${project_id}/x`,
        `/mnt/cocalc/project-${other}/.local/share/cocalc/persist/x.db`,
      ),
    ).toBeUndefined();
    // outside any project
    expect(
      projectDisplayPath(
        `projects/${project_id}/x`,
        "/mnt/cocalc/data/sync/x.db",
      ),
    ).toBeUndefined();
    // not a project stream
    expect(
      projectDisplayPath(
        "accounts/abc/x",
        `/mnt/cocalc/project-${project_id}/x.db`,
      ),
    ).toBeUndefined();
    // a prefix of the project directory is not inside it
    expect(
      projectDisplayPath(
        `projects/${project_id}/x`,
        `/mnt/cocalc/project-${project_id}-scratch/x.db`,
      ),
    ).toBeUndefined();
  });
});
