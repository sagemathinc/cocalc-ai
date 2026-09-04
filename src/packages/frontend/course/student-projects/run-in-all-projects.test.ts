/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  exec,
  start_project,
} from "@cocalc/frontend/frame-editors/generic/client";
import { run_in_all_projects } from "./run-in-all-projects";

jest.mock("@cocalc/frontend/frame-editors/generic/client", () => ({
  exec: jest.fn(),
  start_project: jest.fn(),
}));

jest.mock("./actions", () => ({ MAX_PARALLEL_TASKS: 1 }));

const execMock = exec as jest.Mock;
const startProjectMock = start_project as jest.Mock;

describe("run_in_all_projects", () => {
  let now: number;

  beforeEach(() => {
    now = 0;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    startProjectMock.mockReset().mockResolvedValue(undefined);
    execMock.mockReset().mockImplementation(async () => {
      now += 1_000;
      return { stdout: "ok", stderr: "", exit_code: 0 };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns and logs one input-ordered result per project", async () => {
    const log = jest.fn();
    const results = await run_in_all_projects(
      ["project-1", "project-2"],
      "echo ok",
      undefined,
      60,
      log,
    );

    expect(results.map(({ project_id }) => project_id)).toEqual([
      "project-1",
      "project-2",
    ]);
    expect(results.map(({ total_time }) => total_time)).toEqual([1, 1]);
    expect(results.every(({ status }) => status === "succeeded")).toBe(true);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("identifies a terminal command timeout", async () => {
    execMock.mockRejectedValue("killed command 'sleep 120 '");

    const [result] = await run_in_all_projects(
      ["project-1"],
      "sleep 120",
      undefined,
      60,
    );

    expect(result).toMatchObject({
      project_id: "project-1",
      status: "timed_out",
      phase: "running",
      exit_code: -1,
    });
  });

  it("distinguishes a project startup timeout", async () => {
    startProjectMock.mockRejectedValue(new Error("timeout"));

    const [result] = await run_in_all_projects(["project-1"], "echo ok");

    expect(result).toMatchObject({
      project_id: "project-1",
      status: "timed_out",
      phase: "starting",
      exit_code: -1,
    });
    expect(execMock).not.toHaveBeenCalled();
  });

  it("reports a nonzero exit as a failure", async () => {
    execMock.mockResolvedValue({
      stdout: "",
      stderr: "command failed",
      exit_code: 2,
    });

    const [result] = await run_in_all_projects(["project-1"], "false");

    expect(result.status).toBe("failed");
  });

  it("does not lose results when the live progress callback fails", async () => {
    const results = await run_in_all_projects(
      ["project-1", "project-2"],
      "echo ok",
      undefined,
      60,
      () => {
        throw new Error("progress rendering failed");
      },
    );

    expect(results).toHaveLength(2);
  });
});
