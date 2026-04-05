/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ProjectsTable } from "./table";

const ensureRealtimeFeedForCurrentAccount = jest.fn();
const setState = jest.fn();

jest.mock("../app-framework", () => ({
  redux: {
    getStore: jest.fn((name: string) => {
      if (name === "page") {
        return {
          get: jest.fn(() => undefined),
        };
      }
      if (name === "projects") {
        return {
          get: jest.fn(() => undefined),
        };
      }
      return {
        get: jest.fn(() => undefined),
      };
    }),
    getActions: jest.fn(() => ({
      ensureRealtimeFeedForCurrentAccount,
      setState,
    })),
  },
  Table: class {},
}));

describe("ProjectsTable", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses snapshot-only project bootstrap without a changefeed", () => {
    expect(ProjectsTable.prototype.no_changefeed.call({})).toBe(true);
  });

  it("bootstraps the realtime feed from the first table snapshot", () => {
    const table = {
      get: jest.fn(() => "project-map"),
    };
    ProjectsTable.prototype._change.call({}, table, []);
    expect(ensureRealtimeFeedForCurrentAccount).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith({ project_map: "project-map" });
  });
});
