/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Private app hostnames are retired (D9).  Project code started before the
// upgrade still calls release before deleting an app: it must succeed and do
// nothing.

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: jest.fn() })),
}));

describe("system.releaseProjectAppPrivateHostname (retired)", () => {
  it("reports nothing released, without touching anything", async () => {
    const { releaseProjectAppPrivateHostname } = await import("./system");
    await expect(
      releaseProjectAppPrivateHostname({
        project_id: "00000000-1000-4000-8000-000000000456",
        app_id: "any-app",
      }),
    ).resolves.toEqual({ released: false });
  });
});
