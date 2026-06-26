/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getClusterAccountByIdMock = jest.fn();
const banClusterAccountAndEquivalentEmailsMock = jest.fn();
const resolveMembershipForAccountMock = jest.fn();
const getServerSettingsMock = jest.fn();

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  __esModule: true,
  getClusterAccountById: (...args: any[]) => getClusterAccountByIdMock(...args),
  banClusterAccountAndEquivalentEmails: (...args: any[]) =>
    banClusterAccountAndEquivalentEmailsMock(...args),
}));

jest.mock("./resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

import type { ProjectCryptominingEvidence } from "@cocalc/conat/hub/api/system";
import {
  handleProjectCryptominingEvidence,
  sanitizeCryptominingEvidenceMetadata,
} from "./cryptomining-abuse";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-26T12:00:00.000Z");

const EVIDENCE: ProjectCryptominingEvidence = {
  confidence: "high",
  detector_version: "test",
  detected_at: NOW.toISOString(),
  signals: [
    {
      kind: "network_endpoint_argument",
      pattern: "stratum-url",
      matched: "stratum+tcp://pool.example:3333",
    },
  ],
};

describe("cryptomining abuse policy", () => {
  beforeEach(() => {
    getClusterAccountByIdMock.mockReset().mockResolvedValue({
      account_id: ACCOUNT_ID,
      created: NOW.getTime() - 60_000,
      banned: false,
    });
    resolveMembershipForAccountMock.mockReset().mockResolvedValue({
      class: "free",
      source: "free",
      entitlements: {},
    });
    banClusterAccountAndEquivalentEmailsMock
      .mockReset()
      .mockResolvedValue([{ account_id: ACCOUNT_ID, banned: true }]);
    getServerSettingsMock.mockReset().mockResolvedValue({
      cryptomining_abuse_enforcement_enabled: true,
      cryptomining_abuse_auto_ban_enabled: true,
    });
    delete process.env.COCALC_CRYPTOMINING_AUTO_BAN_ACCOUNT_MAX_AGE_MS;
  });

  it("does nothing by default when site settings are disabled", async () => {
    getServerSettingsMock.mockResolvedValueOnce({});

    const decision = await handleProjectCryptominingEvidence({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      evidence: EVIDENCE,
      now: NOW,
    });

    expect(decision).toEqual({
      should_stop_project: false,
      auto_banned: false,
    });
    expect(getClusterAccountByIdMock).not.toHaveBeenCalled();
    expect(resolveMembershipForAccountMock).not.toHaveBeenCalled();
    expect(banClusterAccountAndEquivalentEmailsMock).not.toHaveBeenCalled();
  });

  it("strips evidence from stored metadata when enforcement is disabled", () => {
    expect(
      sanitizeCryptominingEvidenceMetadata({
        enforcement_enabled: false,
        metadata: {
          runtime_key: "runtime-1",
          cryptomining_evidence: EVIDENCE,
        },
      }),
    ).toEqual({ runtime_key: "runtime-1" });
    expect(
      sanitizeCryptominingEvidenceMetadata({
        enforcement_enabled: true,
        metadata: {
          runtime_key: "runtime-1",
          cryptomining_evidence: EVIDENCE,
        },
      }),
    ).toEqual({
      runtime_key: "runtime-1",
      cryptomining_evidence: EVIDENCE,
    });
  });

  it("auto-bans new free accounts with high-confidence miner evidence", async () => {
    const decision = await handleProjectCryptominingEvidence({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      evidence: EVIDENCE,
      now: NOW,
    });

    expect(decision).toEqual(
      expect.objectContaining({
        should_stop_project: true,
        auto_banned: true,
        membership_class: "free",
        membership_source: "free",
      }),
    );
    expect(banClusterAccountAndEquivalentEmailsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        actor_account_id: null,
        reason: "automatic high-confidence cryptomining detection",
        metadata: expect.objectContaining({
          automatic: true,
          project_id: PROJECT_ID,
          evidence: EVIDENCE,
        }),
      }),
    );
  });

  it("stops but does not auto-ban old free accounts", async () => {
    getClusterAccountByIdMock.mockResolvedValueOnce({
      account_id: ACCOUNT_ID,
      created: NOW.getTime() - 30 * 24 * 60 * 60 * 1000,
      banned: false,
    });

    const decision = await handleProjectCryptominingEvidence({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      evidence: EVIDENCE,
      now: NOW,
    });

    expect(decision).toEqual(
      expect.objectContaining({
        should_stop_project: true,
        auto_banned: false,
        membership_class: "free",
        membership_source: "free",
      }),
    );
    expect(banClusterAccountAndEquivalentEmailsMock).not.toHaveBeenCalled();
  });

  it("stops but does not auto-ban when automatic bans are disabled", async () => {
    getServerSettingsMock.mockResolvedValueOnce({
      cryptomining_abuse_enforcement_enabled: true,
      cryptomining_abuse_auto_ban_enabled: false,
    });

    const decision = await handleProjectCryptominingEvidence({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      evidence: EVIDENCE,
      now: NOW,
    });

    expect(decision).toEqual(
      expect.objectContaining({
        should_stop_project: true,
        auto_banned: false,
        membership_class: "free",
        membership_source: "free",
      }),
    );
    expect(banClusterAccountAndEquivalentEmailsMock).not.toHaveBeenCalled();
  });

  it("stops but does not auto-ban paid accounts", async () => {
    resolveMembershipForAccountMock.mockResolvedValueOnce({
      class: "standard",
      source: "subscription",
      entitlements: {},
    });

    const decision = await handleProjectCryptominingEvidence({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      evidence: EVIDENCE,
      now: NOW,
    });

    expect(decision).toEqual(
      expect.objectContaining({
        should_stop_project: true,
        auto_banned: false,
        membership_class: "standard",
        membership_source: "subscription",
      }),
    );
    expect(banClusterAccountAndEquivalentEmailsMock).not.toHaveBeenCalled();
  });

  it("ignores missing evidence", async () => {
    const decision = await handleProjectCryptominingEvidence({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      now: NOW,
    });

    expect(decision).toEqual({
      should_stop_project: false,
      auto_banned: false,
    });
    expect(getClusterAccountByIdMock).not.toHaveBeenCalled();
    expect(resolveMembershipForAccountMock).not.toHaveBeenCalled();
    expect(banClusterAccountAndEquivalentEmailsMock).not.toHaveBeenCalled();
  });
});
