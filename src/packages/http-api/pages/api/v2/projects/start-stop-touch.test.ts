/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockStartProject = jest.fn();
const mockStopProject = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/conat/api/projects", () => ({
  __esModule: true,
  start: (...args) => mockStartProject(...args),
  stop: (...args) => mockStopProject(...args),
}));

describe("/api/v2/projects legacy control handlers", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockStartProject.mockReset().mockResolvedValue({ run_id: "run-1" });
    mockStopProject.mockReset().mockResolvedValue(undefined);
  });

  it("starts projects through the Conat admission path", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { project_id },
    });

    const { default: handler } = await import("./start");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "ok" });
    expect(mockStartProject).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id,
      wait: false,
    });
  });

  it("stops projects through the Conat routing path", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { project_id },
    });

    const { default: handler } = await import("./stop");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "ok" });
    expect(mockStopProject).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id,
    });
  });

  it("touch starts projects through the Conat admission path", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { project_id },
    });

    const { default: handler } = await import("./touch");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({});
    expect(mockStartProject).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id,
      wait: false,
    });
  });
});
