/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  hasProjectContentReadAccess,
  observeProjectContentEpoch,
  projectContentEpoch,
} from "./content-origin-access";
import { upsertProject } from "./sqlite/projects";

describe("content-origin access state on the host", () => {
  const prevFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
  const project_id = "1fc5e846-547c-4c78-baa3-d0528685eea0";
  const member = "2fc5e846-547c-4c78-baa3-d0528685eea0";

  beforeEach(() => {
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (prevFilename == null) {
      delete process.env.COCALC_LITE_SQLITE_FILENAME;
    } else {
      process.env.COCALC_LITE_SQLITE_FILENAME = prevFilename;
    }
  });

  it("takes the epoch from the hub and never lets it go back down", () => {
    upsertProject({ project_id, users: { [member]: { group: "owner" } } });
    expect(projectContentEpoch(project_id)).toBe(0);
    upsertProject({ project_id, users: { [member]: { group: "owner" } }, content_epoch: 3 });
    expect(projectContentEpoch(project_id)).toBe(3);
    // A delayed or older sync can't bring revoked links back.
    upsertProject({ project_id, users: { [member]: { group: "owner" } }, content_epoch: 1 });
    expect(projectContentEpoch(project_id)).toBe(3);
    // Syncs that don't carry an epoch (other code paths, old hubs) keep it.
    upsertProject({ project_id, users: { [member]: { group: "collaborator" } } });
    expect(projectContentEpoch(project_id)).toBe(3);
    expect(hasProjectContentReadAccess({ account_id: member, project_id })).toBe(true);
  });

  it("records a newer epoch seen in a link, and only a newer one", () => {
    upsertProject({ project_id, users: { [member]: { group: "owner" } }, content_epoch: 2 });
    observeProjectContentEpoch({ project_id, epoch: 1 });
    expect(projectContentEpoch(project_id)).toBe(2);
    observeProjectContentEpoch({ project_id, epoch: 5 });
    expect(projectContentEpoch(project_id)).toBe(5);
    // Membership is untouched.
    expect(hasProjectContentReadAccess({ account_id: member, project_id })).toBe(true);
  });

  it("ignores invalid epochs", () => {
    upsertProject({ project_id, content_epoch: -1 as any });
    expect(projectContentEpoch(project_id)).toBe(0);
    upsertProject({ project_id, content_epoch: 1.5 as any });
    expect(projectContentEpoch(project_id)).toBe(0);
  });
});
