/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { before, after } from "@cocalc/server/test";
import getPool from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";
import { TIER_TEMPLATES } from "@cocalc/util/membership-tier-templates";
import {
  resolveMembershipDetailsForAccount,
  resolveMembershipForAccount,
} from "./resolve";
import {
  createTestAccount,
  createTestAccountEntitlementOverride,
  createTestAdminAssignedMembership,
  createTestMembershipGrant,
  createTestMembershipPackage,
  createTestMembershipTier,
  createTestMembershipSubscription,
} from "@cocalc/server/purchases/test-data";

const savedBayEnv = {
  bay_id: process.env.COCALC_BAY_ID,
  cluster_role: process.env.COCALC_CLUSTER_ROLE,
  seed_bay_id: process.env.COCALC_CLUSTER_SEED_BAY_ID,
};

beforeAll(async () => {
  process.env.COCALC_BAY_ID = "bay-0";
  process.env.COCALC_CLUSTER_ROLE = "seed";
  process.env.COCALC_CLUSTER_SEED_BAY_ID = "bay-0";
  await before({ noConat: true });
}, 15000);
afterAll(async () => {
  await after();
  if (savedBayEnv.bay_id == null) {
    delete process.env.COCALC_BAY_ID;
  } else {
    process.env.COCALC_BAY_ID = savedBayEnv.bay_id;
  }
  if (savedBayEnv.cluster_role == null) {
    delete process.env.COCALC_CLUSTER_ROLE;
  } else {
    process.env.COCALC_CLUSTER_ROLE = savedBayEnv.cluster_role;
  }
  if (savedBayEnv.seed_bay_id == null) {
    delete process.env.COCALC_CLUSTER_SEED_BAY_ID;
  } else {
    process.env.COCALC_CLUSTER_SEED_BAY_ID = savedBayEnv.seed_bay_id;
  }
});

async function makeTestAccountAdmin(account_id: string) {
  await getPool("medium").query(
    "UPDATE accounts SET groups=ARRAY['admin']::text[] WHERE account_id=$1",
    [account_id],
  );
}

async function createResolverTestSiteLicense({
  id,
  name,
  organization_name,
}: {
  id: string;
  name: string;
  organization_name: string;
}) {
  const pool = getPool("medium");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_licenses (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      organization_name TEXT NOT NULL,
      bay_id TEXT NOT NULL,
      owner_account_id UUID,
      allowed_domains TEXT[],
      custom_terms_url TEXT,
      custom_policy_url TEXT,
      terms_version_label TEXT,
      renewal_policy TEXT,
      overage_policy TEXT,
      starts_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      metadata JSONB,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `INSERT INTO site_licenses
       (id, name, organization_name, bay_id, allowed_domains, created, updated)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name,
       organization_name=EXCLUDED.organization_name,
       updated=NOW()`,
    [id, name, organization_name, "test-bay", []],
  );
}

describe("resolveMembershipForAccount", () => {
  const lowTier = `test-low-${uuid()}`;
  const highTier = `test-high-${uuid()}`;

  beforeAll(async () => {
    await createTestMembershipTier({ id: lowTier, priority: 10 });
    await createTestMembershipTier({ id: highTier, priority: 20 });
    await createTestMembershipTier({
      id: "admin",
      priority: 15,
      usage_limits: {
        max_projects: 99,
        max_sponsored_running_projects: 99,
      },
    });
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
    await createTestMembershipSubscription(account_id, {
      class: lowTier,
      cost: 72,
      interval: "year",
    });
    const result = await resolveMembershipForAccount(account_id);
    expect(result.class).toBe(lowTier);
    expect(result.source).toBe("subscription");
    expect(result.subscription_cost).toBe(72);
    expect(result.subscription_interval).toBe("year");
  });

  it("keeps a canceled paid-through subscription active until its period ends", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, {
      class: lowTier,
      status: "canceled",
    });

    const result = await resolveMembershipForAccount(account_id);

    expect(result.class).toBe(lowTier);
    expect(result.source).toBe("subscription");
    expect(result.subscription_status).toBe("canceled");
  });

  it("ignores unpaid membership subscriptions", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, {
      class: highTier,
      status: "unpaid",
    });

    const details = await resolveMembershipDetailsForAccount(account_id);

    expect(details.selected.class).toBe("free");
    expect(details.selected.source).toBe("free");
    expect(
      details.candidates.filter(
        (candidate) => candidate.source === "subscription",
      ),
    ).toHaveLength(0);
  });

  it("ignores past-due membership subscriptions", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, {
      class: highTier,
      status: "past_due",
    });
    await createTestMembershipSubscription(account_id, {
      class: lowTier,
      status: "active",
    });

    const details = await resolveMembershipDetailsForAccount(account_id);

    expect(details.selected.class).toBe(lowTier);
    expect(details.selected.source).toBe("subscription");
    expect(
      details.candidates
        .filter((candidate) => candidate.source === "subscription")
        .map((candidate) => candidate.class),
    ).toEqual([lowTier]);
  });

  it("keeps the higher paid-through subscription effective for a deferred downgrade", async () => {
    const account_id = uuid();
    const end = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, {
      class: highTier,
      end,
      status: "canceled",
    });
    await createTestMembershipSubscription(account_id, {
      class: lowTier,
      end,
      status: "active",
    });

    const details = await resolveMembershipDetailsForAccount(account_id);

    expect(details.selected.class).toBe(highTier);
    expect(details.selected.source).toBe("subscription");
    expect(details.selected.subscription_status).toBe("canceled");
    expect(
      details.candidates.filter(
        (candidate) => candidate.source === "subscription",
      ),
    ).toHaveLength(2);
  });

  it("uses the higher active subscription immediately for an upgrade", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, {
      class: lowTier,
      end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      status: "canceled",
    });
    await createTestMembershipSubscription(account_id, {
      class: highTier,
      end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: "active",
    });

    const result = await resolveMembershipForAccount(account_id);

    expect(result.class).toBe(highTier);
    expect(result.source).toBe("subscription");
    expect(result.subscription_status).toBe("active");
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

  it("returns admin tier for users in the admin group", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await makeTestAccountAdmin(account_id);

    const result = await resolveMembershipForAccount(account_id);

    expect(result.class).toBe("admin");
    expect(result.source).toBe("admin");
    expect(result.effective_limits?.max_projects).toBe(99);
    expect(result.effective_limits?.max_sponsored_running_projects).toBe(99);
  });

  it("deduplicates identical explicit and group admin memberships", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestAdminAssignedMembership(account_id, {
      membership_class: "admin",
    });
    await makeTestAccountAdmin(account_id);

    const details = await resolveMembershipDetailsForAccount(account_id);

    expect(
      details.candidates.filter(
        (candidate) =>
          candidate.source === "admin" && candidate.class === "admin",
      ),
    ).toHaveLength(1);
    expect(details.selected.class).toBe("admin");
    expect(details.selected.source).toBe("admin");
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

  it("uses the current site-license title for grant display metadata", async () => {
    const account_id = uuid();
    const site_license_id = uuid();
    await createTestAccount(account_id);
    await createResolverTestSiteLicense({
      id: site_license_id,
      name: "Summer CoCalc Trial",
      organization_name: "Example University",
    });
    const package_id = await createTestMembershipPackage({
      owner_account_id: account_id,
      kind: "site",
      membership_class: lowTier,
      seat_count: 10,
      metadata: {
        pool_description: "Use CoCalc for advanced research projects.",
        pool_name: "Researcher",
        site_license_id,
      },
    });
    await createTestMembershipGrant(account_id, {
      membership_class: lowTier,
      package_id,
      source: "site-license",
      metadata: {
        organization_name: "Example University",
        pool_name: "Researcher",
        site_license_id,
        site_license_name: "CoCalc Trial",
      },
    });

    const details = await resolveMembershipDetailsForAccount(account_id);

    expect(details.selected.site_license_name).toBe("Summer CoCalc Trial");
    expect(details.selected.organization_name).toBe("Example University");
    expect(details.selected.pool_description).toBe(
      "Use CoCalc for advanced research projects.",
    );
    expect(
      details.candidates.find(
        (candidate) => candidate.grant_source === "site-license",
      ),
    ).toMatchObject({
      organization_name: "Example University",
      pool_description: "Use CoCalc for advanced research projects.",
      pool_name: "Researcher",
      site_license_name: "Summer CoCalc Trial",
    });
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

  it("prefers a subscription over the admin group tier when the subscription has higher priority", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await makeTestAccountAdmin(account_id);
    await createTestMembershipSubscription(account_id, { class: highTier });

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
      cpu_5h_seconds: undefined,
      cpu_7d_seconds: undefined,
      egress_policy: undefined,
      dedicated_host_egress_policy: undefined,
      credit_spend_limit_5h_usd: undefined,
      credit_spend_limit_7d_usd: undefined,
      prepaid_host_usage_limit_5h_usd: undefined,
      prepaid_host_usage_limit_7d_usd: undefined,
      notification_email_send_limit_5h: undefined,
      notification_email_send_limit_7d: undefined,
      acp_max_queued_per_account: undefined,
      acp_max_queued_per_thread: undefined,
      acp_max_created_5h_per_account: undefined,
      acp_max_created_7d_per_account: undefined,
      acp_max_running_per_account: undefined,
      acp_max_running_per_project: undefined,
      acp_max_active_automations_per_project: undefined,
      blob_account_total_bytes: undefined,
      blob_account_count: undefined,
      blob_project_total_bytes: undefined,
      blob_project_count: undefined,
      rootfs_count: undefined,
      rootfs_total_storage_gb: undefined,
      rootfs_max_storage_gb: undefined,
      rootfs_oci_images: undefined,
    });
  });

  it("resolves built-in site-license tier grants even without a database tier row", async () => {
    const account_id = uuid();
    const tier = TIER_TEMPLATES.pro;
    await createTestAccount(account_id);
    await createTestMembershipGrant(account_id, {
      membership_class: tier.id,
      source: "site-license",
    });

    const result = await resolveMembershipForAccount(account_id);

    expect(result.class).toBe(tier.id);
    expect(result.source).toBe("grant");
    expect(result.grant_source).toBe("site-license");
    expect(result.entitlements.features?.create_hosts).toBe(
      tier.features.create_hosts,
    );
    expect(result.entitlements.project_defaults?.disk_quota).toBe(
      tier.project_defaults.disk_quota,
    );
    expect(result.effective_limits.max_projects).toBe(
      tier.usage_limits.max_projects,
    );
    expect(result.effective_limits.rootfs_count).toBe(
      tier.usage_limits.rootfs_count,
    );
    expect(result.effective_limits.rootfs_oci_images).toBe(
      tier.usage_limits.rootfs_oci_images,
    );
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
