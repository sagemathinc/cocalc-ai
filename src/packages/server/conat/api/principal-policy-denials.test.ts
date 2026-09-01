/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import centralLog from "@cocalc/database/postgres/central-log";
import {
  normalizeHubApiPrincipalDenial,
  recordHubApiPrincipalDenial,
  resetHubApiPrincipalDenialsForTests,
} from "./principal-policy-denials";

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockCentralLog = jest.mocked(centralLog);

describe("Hub API principal policy denial audit", () => {
  beforeEach(() => {
    resetHubApiPrincipalDenialsForTests();
    mockCentralLog.mockReset().mockResolvedValue(undefined);
  });

  it("records bounded principal metadata without request arguments", async () => {
    const denial = normalizeHubApiPrincipalDenial({
      principal_type: "project",
      project_id: "project-1",
      method: `purchases.${"x".repeat(300)}`,
      required_policy: "account",
    });

    expect(denial).toEqual({
      principal_type: "project",
      account_id: undefined,
      project_id: "project-1",
      host_id: undefined,
      method: `purchases.${"x".repeat(246)}`,
      required_policy: "account",
    });
  });

  it("rate limits identical denials while retaining distinct methods", async () => {
    const denial = {
      principal_type: "host" as const,
      host_id: "host-1",
      method: "purchases.getMembership",
      required_policy: "account" as const,
    };

    await expect(recordHubApiPrincipalDenial(denial, 100_000)).resolves.toBe(
      true,
    );
    await expect(recordHubApiPrincipalDenial(denial, 100_001)).resolves.toBe(
      false,
    );
    await expect(
      recordHubApiPrincipalDenial(
        { ...denial, method: "purchases.getMemberships" },
        100_001,
      ),
    ).resolves.toBe(true);

    expect(mockCentralLog).toHaveBeenCalledTimes(2);
    expect(mockCentralLog).toHaveBeenCalledWith({
      event: "hub_api_principal_denied",
      value: {
        principal_type: "host",
        account_id: undefined,
        project_id: undefined,
        host_id: "host-1",
        method: "purchases.getMembership",
        required_policy: "account",
      },
    });
  });

  it("records the same denial again after the interval", async () => {
    const denial = {
      principal_type: "project" as const,
      project_id: "project-1",
      method: "org.get",
      required_policy: "account" as const,
    };

    await recordHubApiPrincipalDenial(denial, 100_000);
    await recordHubApiPrincipalDenial(denial, 160_000);

    expect(mockCentralLog).toHaveBeenCalledTimes(2);
  });
});
