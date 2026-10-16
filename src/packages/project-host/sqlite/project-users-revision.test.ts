/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The host's copy of a project's collaborators keeps only the newest
// revision (the owning bay's runtime_authority_revision). Whole copies are
// sent from several places (token issuance, the change poll, project start),
// and one sent before a collaborator change can arrive after it.

import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import { getProject, upsertProject } from "./projects";
import { projectServesComputer } from "../computers";

// updateProjectUsers (hub/projects.ts) stores each copy with upsertProject,
// in the order copies arrive: what happens to each is decided here.
async function updateProjectUsers(opts: {
  project_id: string;
  users: any;
  users_revision?: number;
}) {
  upsertProject(opts);
}

const project_id = "1fc5e846-547c-4c78-baa3-d0528685eea0";
const OWNER = "00000000-1000-4000-8000-000000000001";
const OTHER = "00000000-1000-4000-8000-000000000002";
const ownerOnly = { [OWNER]: { group: "owner" } };
const withCollaborator = {
  [OWNER]: { group: "owner" },
  [OTHER]: { group: "collaborator" },
};

describe("the host's collaborator copy is versioned", () => {
  const prevFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
  beforeEach(() => {
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
  });
  afterEach(() => {
    closeDatabase();
    if (prevFilename == null) delete process.env.COCALC_LITE_SQLITE_FILENAME;
    else process.env.COCALC_LITE_SQLITE_FILENAME = prevFilename;
  });

  it("a stale owner-only copy arriving after a collaborator was added is ignored", async () => {
    await updateProjectUsers({
      project_id,
      users: ownerOnly,
      users_revision: 4,
    });
    expect(projectServesComputer(project_id, OWNER)).toBe(true);
    // The change poll delivers the newer list...
    await updateProjectUsers({
      project_id,
      users: withCollaborator,
      users_revision: 5,
    });
    // ...then a push loaded before the change arrives late.
    await updateProjectUsers({
      project_id,
      users: ownerOnly,
      users_revision: 4,
    });
    expect(getProject(project_id)?.users).toEqual(withCollaborator);
    expect(getProject(project_id)?.users_revision).toBe(5);
    expect(projectServesComputer(project_id, OWNER)).toBe(false);
    // A newer one still lands (the collaborator removed again).
    await updateProjectUsers({
      project_id,
      users: ownerOnly,
      users_revision: 6,
    });
    expect(projectServesComputer(project_id, OWNER)).toBe(true);
  });

  it("once versioned, an unversioned copy never replaces it", () => {
    upsertProject({ project_id, users: withCollaborator, users_revision: 7 });
    upsertProject({ project_id, users: ownerOnly });
    expect(getProject(project_id)?.users).toEqual(withCollaborator);
    expect(getProject(project_id)?.users_revision).toBe(7);
  });

  it("unversioned copies (local, older bays) still work until a versioned one comes, but serve no computer", () => {
    upsertProject({ project_id, users: ownerOnly });
    expect(getProject(project_id)?.users).toEqual(ownerOnly);
    expect(getProject(project_id)?.users_revision).toBeUndefined();
    expect(projectServesComputer(project_id, OWNER)).toBe(false);
    upsertProject({ project_id, users: ownerOnly, users_revision: 1 });
    expect(projectServesComputer(project_id, OWNER)).toBe(true);
  });

  it("other updates keep the collaborators and their revision", () => {
    upsertProject({ project_id, users: ownerOnly, users_revision: 3 });
    upsertProject({ project_id, state: "running" });
    expect(getProject(project_id)).toMatchObject({
      users: ownerOnly,
      users_revision: 3,
    });
  });
});
