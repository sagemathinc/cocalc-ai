/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  normalizeBrowserAutomationAuditValue,
  recordBrowserAutomationAuditEvent,
} from "./browser-automation-audit";
import centralLog from "@cocalc/database/postgres/central-log";

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockCentralLog = jest.mocked(centralLog);

describe("browser automation central audit", () => {
  beforeEach(() => {
    mockCentralLog.mockReset();
    mockCentralLog.mockResolvedValue(undefined);
  });

  it("normalizes only safe metadata and drops script/payload content", () => {
    const normalized = normalizeBrowserAutomationAuditValue({
      account_id: "account-1",
      browser_id: "browser-1",
      project_id: "project-1",
      kind: "exec",
      decision: "allow",
      posture: "dev",
      mode: "raw_js",
      reason: "ok",
      origin: "https://cocalc.example",
      code: "secret raw js",
      payload: { selector: "#password", text: "secret" },
      page_url: "https://cocalc.example/private/path",
    } as any);

    expect(normalized).toEqual({
      source: "browser-session",
      account_id: "account-1",
      browser_id: "browser-1",
      project_id: "project-1",
      kind: "exec",
      decision: "allow",
      posture: "dev",
      mode: "raw_js",
      reason: "ok",
      origin: "https://cocalc.example",
    });
  });

  it("writes central log events with sanitized values", async () => {
    await recordBrowserAutomationAuditEvent({
      event: "browser_raw_exec_allowed",
      value: {
        account_id: "account-1",
        browser_id: "browser-1",
        project_id: "project-1",
        kind: "exec",
        decision: "allow",
        posture: "dev",
        mode: "raw_js",
      },
    });

    expect(mockCentralLog).toHaveBeenCalledWith({
      event: "browser_raw_exec_allowed",
      value: {
        source: "browser-session",
        account_id: "account-1",
        browser_id: "browser-1",
        project_id: "project-1",
        kind: "exec",
        decision: "allow",
        posture: "dev",
        mode: "raw_js",
      },
    });
  });

  it("rejects unknown central event names", async () => {
    await expect(
      recordBrowserAutomationAuditEvent({
        event: "create_account" as any,
        value: { account_id: "account-1" },
      }),
    ).rejects.toThrow("invalid browser automation audit event");

    expect(mockCentralLog).not.toHaveBeenCalled();
  });
});
