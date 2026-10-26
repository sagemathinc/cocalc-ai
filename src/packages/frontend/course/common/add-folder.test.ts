/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let execMock: jest.Mock;
let waitReason: jest.Mock;

jest.mock("../../frame-editors/generic/client", () => ({
  exec: (...args: any[]) => execMock(...args),
}));

jest.mock("../../project/project-start-warning", () => ({
  projectRunWaitReason: (...args: any[]) => waitReason(...args),
}));

import {
  addEachPath,
  CourseUnavailableError,
  ensureCourseFolder,
  waitForCourseData,
} from "./add-folder";

const never = () => new Promise<never>(() => {});

describe("ensureCourseFolder", () => {
  beforeEach(() => {
    execMock = jest.fn(async () => ({ exit_code: 0, stdout: "", stderr: "" }));
    waitReason = jest.fn(() => undefined);
  });

  it("creates the folder in the course project", async () => {
    await ensureCourseFolder({
      project_id: "p",
      path: "Handouts/Handout4",
      itemName: "handout",
    });
    expect(execMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "p",
        command: "mkdir",
        args: ["-p", "Handouts/Handout4"],
      }),
    );
  });

  it.each([
    ["host-unavailable", "the course project's host is not reachable"],
    ["not-running", "the course project is not running"],
    [undefined, "the course project did not answer"],
  ])(
    "fails visibly when the project never answers (%s)",
    async (reason, message) => {
      execMock = jest.fn(never);
      waitReason = jest.fn(() => reason);
      await expect(
        ensureCourseFolder({
          project_id: "p",
          path: "Handout4",
          itemName: "handout",
          timeoutMs: 10,
        }),
      ).rejects.toThrow(message);
    },
  );

  it("stops waiting at the deadline even if the timeout is longer", async () => {
    execMock = jest.fn(never);
    const started = Date.now();
    await expect(
      ensureCourseFolder({
        project_id: "p",
        path: "h",
        itemName: "handout",
        deadline: Date.now() + 20,
      }),
    ).rejects.toThrow("the course project did not answer");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("fails when exec reports that the project was not started", async () => {
    execMock = jest.fn(async () => ({
      exit_code: 1,
      stdout: "",
      stderr: "You must start the project first.",
    }));
    await expect(
      ensureCourseFolder({ project_id: "p", path: "h", itemName: "handout" }),
    ).rejects.toThrow('You must start the project first. -- the handout "h"');
  });
});

describe("waitForCourseData", () => {
  it("returns at once when the course data is ready", async () => {
    await waitForCourseData({
      syncdb: { get_state: () => "ready", wait_until_ready: never },
    });
  });

  it("fails visibly when the course file never finishes loading", async () => {
    await expect(
      waitForCourseData({
        syncdb: { get_state: () => "init", wait_until_ready: never },
        timeoutMs: 10,
      }),
    ).rejects.toThrow("the course file has not finished loading");
  });

  it("stops waiting at the deadline", async () => {
    const started = Date.now();
    await expect(
      waitForCourseData({
        syncdb: { get_state: () => "init", wait_until_ready: never },
        deadline: Date.now() + 20,
      }),
    ).rejects.toThrow("the course file has not finished loading");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("fails when there is no open course file", async () => {
    await expect(waitForCourseData({ syncdb: undefined })).rejects.toThrow(
      "the course file has not finished loading",
    );
  });
});

describe("addEachPath", () => {
  it("adds every path and reports every failure", async () => {
    const added: string[] = [];
    await expect(
      addEachPath(["a", "b", "c"], async (path) => {
        if (path === "b") throw new Error("b failed");
        added.push(path);
      }),
    ).rejects.toThrow("b failed");
    expect(added).toEqual(["a", "c"]);
  });

  it("stops at the first course-unavailable failure", async () => {
    const tried: string[] = [];
    await expect(
      addEachPath(["a", "b", "c"], async (path) => {
        tried.push(path);
        throw new CourseUnavailableError("the course project did not answer");
      }),
    ).rejects.toThrow("the course project did not answer\nnot added: b, c");
    expect(tried).toEqual(["a"]);
  });

  it("does not start a folder after the deadline", async () => {
    const tried: string[] = [];
    const deadline = Date.now() + 20;
    await expect(
      addEachPath(
        ["a", "b", "c"],
        async (path) => {
          tried.push(path);
          // finishes (synchronously) only after the deadline has passed
          while (Date.now() <= deadline) {
            // busy wait
          }
        },
        deadline,
      ),
    ).rejects.toThrow('"b" was not added in time.\nnot added: c');
    expect(tried).toEqual(["a"]);
  });

  it("bounds a folder that is still being added at the deadline", async () => {
    const started = Date.now();
    await expect(
      addEachPath(["a", "b"], never, Date.now() + 30),
    ).rejects.toThrow('"a" was not added in time.\nnot added: b');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("passes the batch deadline to each add", async () => {
    const deadlines: number[] = [];
    const deadline = Date.now() + 5000;
    await addEachPath(
      ["a", "b"],
      async (_path, d) => {
        deadlines.push(d);
      },
      deadline,
    );
    expect(deadlines).toEqual([deadline, deadline]);
  });
});

describe("ensureCourseFolder never answering on several folders", () => {
  it("fails once for the batch, not once per folder", async () => {
    execMock = jest.fn(never);
    waitReason = jest.fn(() => "host-unavailable");
    const started = Date.now();
    await expect(
      addEachPath(["h1", "h2", "h3"], (path) =>
        ensureCourseFolder({
          project_id: "p",
          path,
          itemName: "handout",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("not added: h2, h3");
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
