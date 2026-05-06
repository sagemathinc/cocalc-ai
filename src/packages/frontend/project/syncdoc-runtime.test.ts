/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  closeProjectSyncDocs,
  resetTrackedProjectSyncDocsForTests,
  trackProjectSyncDoc,
} from "./syncdoc-runtime";

describe("project syncdoc runtime tracking", () => {
  afterEach(() => {
    resetTrackedProjectSyncDocsForTests();
  });

  it("closes only tracked docs for the requested project", async () => {
    const closeA = jest.fn().mockResolvedValue(undefined);
    const closeB = jest.fn().mockResolvedValue(undefined);
    trackProjectSyncDoc({
      project_id: "project-a",
      close: closeA,
      once: jest.fn(),
    });
    trackProjectSyncDoc({
      project_id: "project-b",
      close: closeB,
      once: jest.fn(),
    });

    await closeProjectSyncDocs("project-a");

    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).not.toHaveBeenCalled();
  });

  it("ignores docs without a usable project id", async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    trackProjectSyncDoc({
      project_id: "",
      close,
      once: jest.fn(),
    });

    await closeProjectSyncDocs("project-a");

    expect(close).not.toHaveBeenCalled();
  });
});
