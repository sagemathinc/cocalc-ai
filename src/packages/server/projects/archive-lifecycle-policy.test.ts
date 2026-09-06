/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  evaluateProjectArchiveEligibility,
  isProjectArchiveBackupCurrent,
} from "./archive-lifecycle-policy";
import type {
  ArchiveLifecycleAccountStatus,
  ArchiveLifecycleProjectSnapshot,
  ProjectArchiveLifecycleConfig,
} from "./archive-lifecycle-types";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PAID = "22222222-2222-4222-8222-222222222222";
const BAY = "bay-1";
const HOST = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-22T12:00:00.000Z");

const config: ProjectArchiveLifecycleConfig = {
  enabled: true,
  reportOnly: true,
  freeAfterDays: 30,
  bannedAfterDays: 7,
  batchLimit: 25,
  globalPerHour: 10,
  perHostConcurrency: 1,
  canaryBays: [],
  canaryHosts: [],
};

function project(
  overrides: Partial<ArchiveLifecycleProjectSnapshot> = {},
): ArchiveLifecycleProjectSnapshot {
  return {
    project_id: "44444444-4444-4444-8444-444444444444",
    owning_bay_id: BAY,
    host_id: HOST,
    host_status: "active",
    deleted: null,
    provisioned: true,
    deletion_protection: false,
    state: { state: "opened" },
    users: { [OWNER]: { group: "owner" } },
    created: "2026-01-01T00:00:00.000Z",
    last_edited: "2026-07-01T00:00:00.000Z",
    last_changed: "2026-07-01T00:00:00.000Z",
    last_changed_generation: 10,
    last_backup: "2026-07-02T00:00:00.000Z",
    last_backup_generation: 10,
    backup_repo_id: "55555555-5555-4555-8555-555555555555",
    archive_lifecycle_job_id: null,
    active_published_path: false,
    ...overrides,
  };
}

function status(
  account_id: string,
  overrides: Partial<ArchiveLifecycleAccountStatus> = {},
): ArchiveLifecycleAccountStatus {
  return {
    account_id,
    resolved: true,
    banned: false,
    banned_at: null,
    membership: { class: "free", source: "free", entitlements: {} } as any,
    ...overrides,
  };
}

function decide({
  snapshot = project(),
  statuses = [status(OWNER)],
  policy = config,
}: {
  snapshot?: ArchiveLifecycleProjectSnapshot;
  statuses?: ArchiveLifecycleAccountStatus[];
  policy?: ProjectArchiveLifecycleConfig;
} = {}) {
  return evaluateProjectArchiveEligibility({
    project: snapshot,
    accounts: new Map(statuses.map((entry) => [entry.account_id, entry])),
    config: policy,
    currentBayId: BAY,
    now: NOW,
  });
}

describe("project archive lifecycle policy", () => {
  it("selects an inactive free project using project-local last_edited", () => {
    expect(decide()).toMatchObject({
      eligible: true,
      reason: "free-inactive",
    });
    expect(
      decide({
        snapshot: project({ last_edited: "2026-08-22T11:00:00.000Z" }),
      }),
    ).toMatchObject({ eligible: false, exclusion: "recent-edit" });
  });

  it("uses created when last_edited is null and includes the exact cutoff", () => {
    expect(
      decide({
        snapshot: project({
          last_edited: null,
          created: "2026-07-23T12:00:00.000Z",
        }),
      }),
    ).toMatchObject({ eligible: true, reason: "free-inactive" });
  });

  it("protects active shares and non-banned paid collaborators", () => {
    expect(
      decide({ snapshot: project({ active_published_path: true }) }),
    ).toMatchObject({ eligible: false, exclusion: "published" });
    expect(
      decide({
        snapshot: project({
          users: {
            [OWNER]: { group: "owner" },
            [PAID]: { group: "collaborator" },
          },
        }),
        statuses: [
          status(OWNER),
          status(PAID, {
            membership: {
              class: "premium",
              source: "subscription",
              entitlements: {},
            } as any,
          }),
        ],
      }),
    ).toMatchObject({ eligible: false, exclusion: "paid-collaborator" });
  });

  it("fails closed on unresolved remote account authority", () => {
    expect(
      decide({ statuses: [status(OWNER, { resolved: false })] }),
    ).toMatchObject({
      eligible: false,
      exclusion: "unknown-account-authority",
    });
    expect(
      decide({ statuses: [status(OWNER, { membership: null })] }),
    ).toMatchObject({
      eligible: false,
      exclusion: "unknown-account-authority",
    });
  });

  it("selects all-banned projects after the latest ban grace period", () => {
    const snapshot = project({
      active_published_path: true,
      users: {
        [OWNER]: { group: "owner" },
        [PAID]: { group: "collaborator" },
      },
    });
    expect(
      decide({
        snapshot,
        statuses: [
          status(OWNER, {
            banned: true,
            banned_at: "2026-08-01T00:00:00.000Z",
            membership: null,
          }),
          status(PAID, {
            banned: true,
            banned_at: "2026-08-15T12:00:00.000Z",
            membership: {
              class: "premium",
              source: "subscription",
              entitlements: {},
            } as any,
          }),
        ],
      }),
    ).toMatchObject({
      eligible: true,
      reason: "all-collaborators-banned",
      latest_banned_at: "2026-08-15T12:00:00.000Z",
    });
  });

  it("uses the latest ban time and does not bypass the grace period", () => {
    expect(
      decide({
        statuses: [
          status(OWNER, {
            banned: true,
            banned_at: "2026-08-20T00:00:00.000Z",
          }),
        ],
      }),
    ).toMatchObject({ eligible: false, exclusion: "ban-grace-period" });
  });

  it.each([
    ["deleted", project({ deleted: "2026-08-01T00:00:00Z" })],
    ["already-archived", project({ state: { state: "archived" } })],
    ["unprovisioned", project({ provisioned: false })],
    ["protected", project({ deletion_protection: true })],
    ["busy-or-unknown-state", project({ state: { state: "running" } })],
    ["unknown-collaborators", project({ users: {} })],
    ["host-unavailable", project({ host_status: "off" })],
  ])("excludes %s projects", (exclusion, snapshot) => {
    expect(decide({ snapshot })).toMatchObject({ eligible: false, exclusion });
  });

  it("requires the backup to cover the latest persisted generation", () => {
    const stale = project({
      last_changed_generation: 11,
      last_backup_generation: 10,
    });
    expect(isProjectArchiveBackupCurrent(stale)).toBe(false);
    expect(decide({ snapshot: stale })).toMatchObject({
      eligible: false,
      exclusion: "backup-unsafe",
    });
  });

  it("compares BIGINT generations without rounding a stale backup into equality", () => {
    expect(
      isProjectArchiveBackupCurrent(
        project({
          last_changed_generation: "9007199254740993",
          last_backup_generation: "9007199254740992",
        }),
      ),
    ).toBe(false);
    expect(
      isProjectArchiveBackupCurrent(
        project({
          last_changed_generation: "9007199254740993",
          last_backup_generation: "9007199254740993",
        }),
      ),
    ).toBe(true);
  });

  it.each(["invalid", "", "1.5", -1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed freshness evidence %s",
    (value) => {
      expect(
        isProjectArchiveBackupCurrent(
          project({ last_changed_generation: value }),
        ),
      ).toBe(false);
      expect(
        isProjectArchiveBackupCurrent(
          project({ last_backup_generation: value }),
        ),
      ).toBe(false);
    },
  );

  it("does not discard an invalid change time or missing backup generation", () => {
    expect(
      isProjectArchiveBackupCurrent(project({ last_changed: "invalid" })),
    ).toBe(false);
    expect(
      isProjectArchiveBackupCurrent(project({ last_backup_generation: null })),
    ).toBe(false);
  });

  it("enforces bay and host canaries", () => {
    expect(
      decide({ policy: { ...config, canaryBays: ["other-bay"] } }),
    ).toMatchObject({ eligible: false, exclusion: "canary-excluded" });
    expect(
      decide({ policy: { ...config, canaryHosts: ["other-host"] } }),
    ).toMatchObject({ eligible: false, exclusion: "canary-excluded" });
  });
});
