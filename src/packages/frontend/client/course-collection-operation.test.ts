/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));

import { ProjectClient } from "./project";

// Collections live on the course project's owning bay (#1001); ones made
// before that are found on the caller's own bay.
function client({
  routed,
  local,
  found = true,
}: {
  routed?: any;
  local?: any;
  found?: boolean;
}) {
  const hub = {
    projects: {
      getCourseCollectionOperation: jest.fn(async () => routed),
      cancelCourseCollectionOperation: jest.fn(async () => ({ found })),
    },
    lro: {
      get: jest.fn(async () => local),
      cancel: jest.fn(async () => undefined),
    },
  };
  const projectClient = new ProjectClient({
    conat_client: { hub },
  } as any);
  return { projectClient, hub };
}

const opts = { course_project_id: "course", op_id: "op" };
const collection = {
  op_id: "op",
  kind: "course-collect-assignment",
  scope_type: "project",
  scope_id: "course",
};

describe("course collection operations", () => {
  it("reads a collection from the course project's owning bay", async () => {
    const { projectClient, hub } = client({ routed: { op_id: "op" } });
    await expect(
      projectClient.getCourseCollectionOperation(opts),
    ).resolves.toEqual({ op_id: "op" });
    expect(hub.projects.getCourseCollectionOperation).toHaveBeenCalledWith(
      opts,
    );
    expect(hub.lro.get).not.toHaveBeenCalled();
  });

  it("falls back to this account's bay for an older collection", async () => {
    const { projectClient, hub } = client({ local: collection });
    await expect(
      projectClient.getCourseCollectionOperation({ ...opts, timeout: 5 }),
    ).resolves.toEqual(collection);
    expect(hub.lro.get).toHaveBeenCalledWith({ op_id: "op", timeout: 5 });
  });

  it("ignores a local operation that is not a collection of this course", async () => {
    for (const local of [
      { ...collection, scope_id: "other-course" },
      { ...collection, kind: "copy-path-between-projects" },
    ]) {
      const { projectClient, hub } = client({ local, found: false });
      await expect(
        projectClient.getCourseCollectionOperation(opts),
      ).resolves.toBeUndefined();
      await expect(
        projectClient.cancelCourseCollectionOperation(opts),
      ).rejects.toThrow("scheduled collection not found");
      expect(hub.lro.cancel).not.toHaveBeenCalled();
    }
  });

  it("cancels on the owning bay, and locally only if not found there", async () => {
    const owning = client({ found: true });
    await owning.projectClient.cancelCourseCollectionOperation(opts);
    expect(
      owning.hub.projects.cancelCourseCollectionOperation,
    ).toHaveBeenCalledWith(opts);
    expect(owning.hub.lro.cancel).not.toHaveBeenCalled();

    const older = client({ found: false, local: collection });
    await older.projectClient.cancelCourseCollectionOperation(opts);
    expect(older.hub.lro.cancel).toHaveBeenCalledWith({ op_id: "op" });
  });

  it("fails rather than reporting a collection it cannot find as canceled", async () => {
    // e.g. scheduled before #1001 by an instructor homed on another bay
    const { projectClient, hub } = client({ found: false });
    await expect(
      projectClient.cancelCourseCollectionOperation(opts),
    ).rejects.toThrow("scheduled collection not found");
    expect(hub.lro.cancel).not.toHaveBeenCalled();
  });
});
