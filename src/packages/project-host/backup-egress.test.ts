/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getManagedProjectEgressPolicyMock = jest.fn();
const recordManagedProjectEgressMock = jest.fn();
const isProjectHostManagedEgressEnforcedMock = jest.fn();
const isProjectHostManagedEgressTrackingEnabledMock = jest.fn();

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/lite/hub/api", () => ({
  __esModule: true,
  hubApi: {
    system: {
      getManagedProjectEgressPolicy: (...args: any[]) =>
        getManagedProjectEgressPolicyMock(...args),
      recordManagedProjectEgress: (...args: any[]) =>
        recordManagedProjectEgressMock(...args),
    },
  },
}));

jest.mock("./managed-egress-runtime", () => ({
  __esModule: true,
  isProjectHostManagedEgressEnforced: (...args: any[]) =>
    isProjectHostManagedEgressEnforcedMock(...args),
  isProjectHostManagedEgressTrackingEnabled: (...args: any[]) =>
    isProjectHostManagedEgressTrackingEnabledMock(...args),
}));

import {
  MANAGED_BACKUP_EGRESS_CATEGORY,
  checkManagedBackupAllowedBestEffort,
  getManagedBackupEgressBytes,
  recordManagedBackupEgressBestEffort,
} from "./backup-egress";

describe("project-host backup managed egress", () => {
  beforeEach(() => {
    getManagedProjectEgressPolicyMock.mockReset();
    recordManagedProjectEgressMock.mockReset();
    isProjectHostManagedEgressEnforcedMock.mockReset();
    isProjectHostManagedEgressTrackingEnabledMock.mockReset();
    isProjectHostManagedEgressEnforcedMock.mockReturnValue(true);
    isProjectHostManagedEgressTrackingEnabledMock.mockReturnValue(true);
  });

  it("prefers packed bytes and falls back through rustic summary fields", () => {
    expect(
      getManagedBackupEgressBytes({
        data_added_packed: 11,
        data_added: 22,
        total_bytes_processed: 33,
      }),
    ).toBe(11);
    expect(
      getManagedBackupEgressBytes({
        data_added: 22,
        total_bytes_processed: 33,
      }),
    ).toBe(22);
    expect(
      getManagedBackupEgressBytes({
        total_bytes_processed: 33,
      }),
    ).toBe(33);
    expect(getManagedBackupEgressBytes({})).toBe(0);
  });

  it("allows backups immediately when enforcement is off", async () => {
    isProjectHostManagedEgressEnforcedMock.mockReturnValue(false);
    await expect(
      checkManagedBackupAllowedBestEffort({ project_id: "proj-1" }),
    ).resolves.toEqual({ allowed: true });
    expect(getManagedProjectEgressPolicyMock).not.toHaveBeenCalled();
  });

  it("allows admin host drain backups without consulting policy", async () => {
    await expect(
      checkManagedBackupAllowedBestEffort({
        project_id: "proj-1",
        managed_egress_override: "admin-host-drain",
      }),
    ).resolves.toEqual({ allowed: true });
    expect(getManagedProjectEgressPolicyMock).not.toHaveBeenCalled();
  });

  it("blocks new backups when the owner is already over the managed egress limit", async () => {
    getManagedProjectEgressPolicyMock.mockResolvedValue({
      allowed: false,
      category: MANAGED_BACKUP_EGRESS_CATEGORY,
      managed_egress_5h_bytes: 9_000_000,
      managed_egress_7d_bytes: 12_000_000,
      egress_5h_bytes: 8_000_000,
      egress_7d_bytes: 20_000_000,
      managed_egress_categories_5h_bytes: {
        "backup-upload": 7_000_000,
        "raw-network": 2_000_000,
      },
    });
    await expect(
      checkManagedBackupAllowedBestEffort({ project_id: "proj-1" }),
    ).resolves.toEqual({
      allowed: false,
      message: expect.stringContaining(
        "Managed backup upload limit reached for this account.",
      ),
    });
    expect(getManagedProjectEgressPolicyMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      category: MANAGED_BACKUP_EGRESS_CATEGORY,
    });
  });

  it("records successful backup upload bytes against the project owner account", async () => {
    recordManagedProjectEgressMock.mockResolvedValue({
      recorded: true,
      account_id: "acct-1",
    });
    await recordManagedBackupEgressBestEffort({
      project_id: "proj-1",
      backup_id: "backup-1",
      tags: ["manual", "foo=bar"],
      summary: {
        data_added_packed: 1234,
        data_added: 5678,
        total_bytes_processed: 9999,
        files_new: 12,
      },
    });
    expect(recordManagedProjectEgressMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      category: MANAGED_BACKUP_EGRESS_CATEGORY,
      bytes: 1234,
      metadata: {
        backup_id: "backup-1",
        tags: ["manual", "foo=bar"],
        data_added_packed: 1234,
        data_added: 5678,
        total_bytes_processed: 9999,
        files_new: 12,
      },
    });
  });

  it("does not record zero-byte backups", async () => {
    await recordManagedBackupEgressBestEffort({
      project_id: "proj-1",
      backup_id: "backup-1",
      summary: {},
    });
    expect(recordManagedProjectEgressMock).not.toHaveBeenCalled();
  });
});
