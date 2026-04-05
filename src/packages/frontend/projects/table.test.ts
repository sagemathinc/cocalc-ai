/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ProjectsTable } from "./table";

jest.mock("../app-framework", () => ({
  redux: {
    getStore: jest.fn(() => ({
      get: jest.fn(() => undefined),
    })),
  },
  Table: class {},
}));

describe("ProjectsTable", () => {
  it("uses snapshot-only project bootstrap without a changefeed", () => {
    expect(ProjectsTable.prototype.no_changefeed.call({})).toBe(true);
  });
});
