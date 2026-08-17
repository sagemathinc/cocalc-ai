/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  clearReducedProjectState,
  getReducedProjectDirectoryPath,
  getReducedProjectState,
  setReducedProjectPath,
  setReducedProjectState,
  subscribeReducedProjectState,
} from "./reduced-runtime";

describe("reduced project runtime state", () => {
  const projectId = "00000000-0000-4000-8000-000000000001";

  afterEach(() => clearReducedProjectState(projectId));

  it("publishes path changes without project Redux", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeReducedProjectState(projectId, listener);
    setReducedProjectState({
      homeDirectory: "/home/user",
      path: "/home/user",
      projectId,
      title: "Slow network project",
      viewer: false,
    });
    setReducedProjectPath(projectId, "/home/user/docs");

    expect(getReducedProjectState(projectId)?.path).toBe("/home/user/docs");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("only accepts ordinary directory targets", () => {
    expect(
      getReducedProjectDirectoryPath({
        homeDirectory: "/home/user",
        target: "files/",
      }),
    ).toBe("/home/user");
    expect(
      getReducedProjectDirectoryPath({
        homeDirectory: "/home/user",
        target: "files/home/user/docs/",
      }),
    ).toBe("/home/user/docs");
    expect(
      getReducedProjectDirectoryPath({
        homeDirectory: "/home/user",
        target: "files/home/user/report.pdf",
      }),
    ).toBeUndefined();
    expect(
      getReducedProjectDirectoryPath({
        homeDirectory: "/home/user",
        target: "files/.backups/",
      }),
    ).toBeUndefined();
  });
});
