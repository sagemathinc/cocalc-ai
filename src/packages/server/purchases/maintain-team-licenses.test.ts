/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const createTeamLicenseRenewalPayment = jest.fn();
const query = jest.fn(async () => ({ rows: [] }));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ debug: jest.fn() }),
}));
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query }),
}));
jest.mock("./team-license", () => ({
  createTeamLicenseRenewalPayment: (...args: unknown[]) =>
    createTeamLicenseRenewalPayment(...args),
  getDueTeamLicensesForRenewal: async () => [
    { id: "always-failing", owner_account_id: "account-a" },
    { id: "healthy", owner_account_id: "account-b" },
  ],
}));

import maintainTeamLicenses, { _TEST_ } from "./maintain-team-licenses";

describe("bounded team-license maintenance", () => {
  beforeEach(() => {
    _TEST_.recentAttempts.clear();
    query.mockClear();
    createTeamLicenseRenewalPayment.mockReset();
    createTeamLicenseRenewalPayment.mockImplementation(
      async ({ team_license_id }: { team_license_id: string }) => {
        if (team_license_id === "always-failing") {
          throw new Error("persistent renewal failure");
        }
      },
    );
  });

  it("advances past a persistently failing first due license", async () => {
    await maintainTeamLicenses({ max_licenses: 1 });
    await maintainTeamLicenses({ max_licenses: 1 });

    expect(createTeamLicenseRenewalPayment).toHaveBeenLastCalledWith({
      team_license_id: "healthy",
      owner_account_id: "account-b",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
