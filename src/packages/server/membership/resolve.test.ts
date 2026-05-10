/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { before, after } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  resolveMembershipDetailsForAccount,
  resolveMembershipForAccount,
} from "./resolve";
import {
  createTestAccount,
  createTestAccountEntitlementOverride,
  createTestAdminAssignedMembership,
  createTestMembershipGrant,
  createTestMembershipTier,
  createTestMembershipSubscription,
} from "@cocalc/server/purchases/test-data";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("resolveMembershipForAccount", () => {
  const lowTier = `test-low-${uuid()}`;
  const highTier = `test-high-${uuid()}`;

  beforeAll(async () => {
    await createTestMembershipTier({ id: lowTier, priority: 10 });
    await createTestMembershipTier({ id: highTier, priority: 20 });
  });

  it("returns free when no membership subscription exists", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe("free");
    expect(result.source).toBe("free");
  });

  it("returns membership class when subscription exists", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, { class: lowTier });
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe(lowTier);
    expect(result.source).toBe("subscription");
  });

  it("returns admin assigned membership when no subscription exists", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestAdminAssignedMembership(account_id, {
      membership_class: highTier,
    });
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe(highTier);
    expect(result.source).toBe("admin");
  });

  it("returns a granted membership when no subscription or admin assignment exists", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipGrant(account_id, {
      membership_class: lowTier,
      source: "student-pay",
    });
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe(lowTier);
    expect(result.source).toBe("grant");
    expect(result.grant_source).toBe("student-pay");
  });

  it("picks the highest priority tier across subscription and admin", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, { class: lowTier });
    await createTestAdminAssignedMembership(account_id, {
      membership_class: highTier,
    });
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe(highTier);
    expect(result.source).toBe("admin");
  });

  it("prefers subscription when it has higher priority", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, { class: highTier });
    await createTestAdminAssignedMembership(account_id, {
      membership_class: lowTier,
    });
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe(highTier);
    expect(result.source).toBe("subscription");
  });

  it("picks the highest priority tier across grants, subscriptions, and admin assignments", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipGrant(account_id, {
      membership_class: lowTier,
      source: "course-seat",
    });
    await createTestAdminAssignedMembership(account_id, {
      membership_class: lowTier,
    });
    await createTestMembershipSubscription(account_id, { class: highTier });
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe(highTier);
    expect(result.source).toBe("subscription");
  });

  it("includes usage limits from the selected membership tier", async () => {
    const account_id = uuid();
    const usageTier = `test-usage-${uuid()}`;
    await createTestAccount(account_id);
    await createTestMembershipTier({
      id: usageTier,
      priority: 30,
      usage_limits: {
        shared_compute_priority: 7,
        max_projects: 42,
        max_snapshots_per_project: 8,
        max_backups_per_project: 5,
      },
    });
    await createTestMembershipSubscription(account_id, { class: usageTier });
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe(usageTier);
    expect(result.entitlements.usage_limits).toEqual({
      shared_compute_priority: 7,
      max_projects: 42,
      max_snapshots_per_project: 8,
      max_backups_per_project: 5,
    });
    expect(result.effective_limits).toEqual({
      shared_compute_priority: 7,
      total_storage_soft_bytes: undefined,
      total_storage_hard_bytes: undefined,
      max_projects: 42,
      max_snapshots_per_project: 8,
      max_backups_per_project: 5,
      egress_5h_bytes: undefined,
      egress_7d_bytes: undefined,
      egress_policy: undefined,
      dedicated_host_egress_policy: undefined,
      credit_spend_limit_5h_usd: undefined,
      credit_spend_limit_7d_usd: undefined,
      prepaid_host_usage_limit_5h_usd: undefined,
      prepaid_host_usage_limit_7d_usd: undefined,
    });
  });

  it("applies active admin entitlement overrides to the selected membership", async () => {
    const account_id = uuid();
    const overrideTier = `test-override-${uuid()}`;
    await createTestAccount(account_id);
    await createTestMembershipTier({
      id: overrideTier,
      priority: 30,
      features: { create_hosts: false },
      project_defaults: {
        disk_quota: 10000,
        memory: 8000,
      },
      ai_limits: {
        units_5h: 50,
        units_7d: 200,
      },
      usage_limits: {
        max_projects: 10,
        credit_spend_limit_7d_usd: 100,
      },
    });
    await createTestMembershipSubscription(account_id, { class: overrideTier });
    await createTestAccountEntitlementOverride(account_id, {
      features: { create_hosts: true },
      project_defaults: {
        disk_quota: { mode: "minimum", value: 20000 },
        memory: { mode: "set", value: 12000 },
      },
      ai_limits: {
        units_5h: { mode: "maximum", value: 25 },
        units_7d: { mode: "minimum", value: 500 },
      },
      usage_limits: {
        max_projects: { mode: "maximum", value: 5 },
        credit_spend_limit_7d_usd: { mode: "minimum", value: 300 },
      },
    });

    const result = await resolveMembershipForAccount(account_id);

    expect(result.entitlements.features?.create_hosts).toBe(true);
    expect(result.entitlements.project_defaults).toMatchObject({
      disk_quota: 20000,
      memory: 12000,
    });
    expect(result.entitlements.ai_limits).toMatchObject({
      units_5h: 25,
      units_7d: 500,
    });
    expect(result.effective_limits).toMatchObject({
      max_projects: 5,
      credit_spend_limit_7d_usd: 300,
    });

    const details = await resolveMembershipDetailsForAccount(account_id);
    expect(details.admin_override?.effects).toEqual(
      expect.arrayContaining([
        "Per-project disk quota: minimum 20000 MB",
        "AI units, 5-hour window: maximum 25 units",
        "Owned projects: maximum 5 projects",
        "Dedicated host creation: allow",
      ]),
    );
  });
});
