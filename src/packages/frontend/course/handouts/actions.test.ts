/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let ensureFolder: jest.Mock;
let waitForData: jest.Mock;

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { server_time: () => new Date() },
}));

jest.mock("../common/add-folder", () => ({
  ...jest.requireActual("../common/add-folder"),
  ensureCourseFolder: (...args: any[]) => ensureFolder(...args),
  waitForCourseData: (...args: any[]) => waitForData(...args),
}));

import { fromJS } from "immutable";
import { HandoutsActions } from "./actions";

function setup(handouts: Record<string, any> = {}) {
  const store = fromJS({
    course_project_id: "course",
    handouts,
  });
  const sets: any[] = [];
  const errors: string[] = [];
  const courseActions: any = {
    get_store: () => store,
    set: (obj: any) => sets.push(obj),
    set_error: (err: string) => errors.push(err),
    syncdb: { get_state: () => "ready" },
  };
  return { actions: new HandoutsActions(courseActions), sets, errors };
}

describe("addHandout", () => {
  beforeEach(() => {
    ensureFolder = jest.fn(async () => {});
    waitForData = jest.fn(async () => {});
  });

  it("creates the folder and adds the handout", async () => {
    const { actions, sets } = setup();
    await actions.addHandout(["Handouts/Handout4"]);
    expect(ensureFolder).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "Handouts/Handout4",
        itemName: "handout",
      }),
    );
    expect(sets).toEqual([
      expect.objectContaining({
        table: "handouts",
        path: "Handouts/Handout4",
        target_path: "Handouts/Handout4",
      }),
    ]);
  });

  it("says so when the folder is already a handout", async () => {
    const { actions, sets } = setup({
      h1: { handout_id: "h1", path: "Handout4" },
    });
    await expect(actions.addHandout(["Handout4"])).rejects.toThrow(
      '"Handout4" is already a handout in this course.',
    );
    expect(sets).toEqual([]);
  });

  it("undeletes a deleted handout", async () => {
    const { actions, sets } = setup({
      h1: { handout_id: "h1", path: "Handout4", deleted: true },
    });
    await actions.addHandout("Handout4");
    expect(sets).toEqual([
      { deleted: false, handout_id: "h1", table: "handouts" },
    ]);
    expect(ensureFolder).not.toHaveBeenCalled();
  });

  it("reports a failure instead of doing nothing", async () => {
    ensureFolder = jest.fn(async () => {
      throw new Error("the course project did not answer");
    });
    const { actions, sets, errors } = setup();
    await expect(actions.addHandout(["Handout4"])).rejects.toThrow(
      "the course project did not answer",
    );
    expect(errors).toEqual([
      "error creating handout: Error: the course project did not answer",
    ]);
    expect(sets).toEqual([]);
  });

  it("reports when the course file is not loaded", async () => {
    waitForData = jest.fn(async () => {
      throw new Error("the course file has not finished loading");
    });
    const { actions, sets } = setup();
    await expect(actions.addHandout("Handout4")).rejects.toThrow(
      "the course file has not finished loading",
    );
    expect(ensureFolder).not.toHaveBeenCalled();
    expect(sets).toEqual([]);
  });

  it("adds the other handouts when one fails", async () => {
    ensureFolder = jest.fn(async ({ path }) => {
      if (path === "Handout2") throw new Error("no");
    });
    const { actions, sets } = setup();
    await expect(
      actions.addHandout(["Handout1", "Handout2", "Handout3"]),
    ).rejects.toThrow("no");
    expect(sets.map((x) => x.path)).toEqual(["Handout1", "Handout3"]);
  });

  it("stores home-relative paths", async () => {
    const { actions, sets } = setup();
    await actions.addHandout("/home/user/Handouts/Handout4");
    expect(sets[0].path).toBe("Handouts/Handout4");
  });
});
