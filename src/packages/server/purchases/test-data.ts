import dayjs from "dayjs";
import createAccount from "@cocalc/server/accounts/create-account";
import createSubscription from "./create-subscription";
import { uuid } from "@cocalc/util/misc";
import getPool from "@cocalc/database/pool";
import type { MembershipClass } from "@cocalc/util/db-schema/subscriptions";

export async function createTestAccount(account_id: string) {
  await createAccount({
    email: `${uuid()}@test.com`,
    password: "cocalcrulez",
    firstName: "Test",
    lastName: "User",
    account_id,
  });
}

export async function createTestMembershipSubscription(
  account_id: string,
  opts?: {
    class?: MembershipClass;
    interval?: "month" | "year";
    start?: Date;
    end?: Date;
    cost?: number;
    status?: "active" | "canceled" | "unpaid" | "past_due";
  },
) {
  const now = dayjs();
  const interval = opts?.interval ?? "month";
  const start = opts?.start ?? now.toDate();
  const end =
    opts?.end ??
    (interval == "month" ? now.add(1, "month") : now.add(1, "year")).toDate();
  const cost = opts?.cost ?? 10;
  const status = opts?.status ?? "active";
  const membershipClass = opts?.class ?? "member";
  const subscription_id = await createSubscription(
    {
      account_id,
      cost,
      interval,
      current_period_start: start,
      current_period_end: end,
      status,
      metadata: { type: "membership", class: membershipClass },
      latest_purchase_id: 0,
    },
    null,
  );
  return { subscription_id, cost, start, end, membershipClass, interval };
}

export async function createTestMembershipTier(opts: {
  id: MembershipClass;
  priority?: number;
  price_monthly?: number;
  price_yearly?: number;
  project_defaults?: Record<string, unknown>;
  ai_limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
  usage_limits?: Record<string, unknown>;
}) {
  const pool = getPool("medium");
  await pool.query(
    `INSERT INTO membership_tiers
      (id, label, store_visible, priority, price_monthly, price_yearly,
       project_defaults, ai_limits, features, usage_limits,
       disabled, notes, history, created, updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8::JSONB,$9::JSONB,$10::JSONB,$11,$12,$13::JSONB,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       label=EXCLUDED.label,
       store_visible=EXCLUDED.store_visible,
       priority=EXCLUDED.priority,
       price_monthly=EXCLUDED.price_monthly,
       price_yearly=EXCLUDED.price_yearly,
       project_defaults=EXCLUDED.project_defaults,
       ai_limits=EXCLUDED.ai_limits,
       features=EXCLUDED.features,
       usage_limits=EXCLUDED.usage_limits,
       disabled=EXCLUDED.disabled,
       notes=EXCLUDED.notes,
       updated=NOW()`,
    [
      opts.id,
      opts.id,
      false,
      opts.priority ?? 0,
      opts.price_monthly ?? 0,
      opts.price_yearly ?? 0,
      opts.project_defaults ?? {},
      opts.ai_limits ?? {},
      opts.features ?? {},
      opts.usage_limits ?? {},
      false,
      null,
      [],
    ],
  );
}

export async function createTestAccountEntitlementOverride(
  account_id: string,
  opts?: {
    enabled?: boolean;
    features?: Record<string, unknown>;
    project_defaults?: Record<string, unknown>;
    ai_limits?: Record<string, unknown>;
    usage_limits?: Record<string, unknown>;
    dedicated_hosts?: Record<string, unknown>;
    reason?: string | null;
    expires_at?: Date | null;
    updated_by?: string;
    updated_at?: Date;
  },
) {
  const pool = getPool("medium");
  await pool.query(
    `INSERT INTO account_entitlement_overrides (
       account_id, enabled, features, project_defaults, ai_limits,
       usage_limits, dedicated_hosts, reason, expires_at, updated_by,
       updated_at
     )
     VALUES ($1,$2,$3::JSONB,$4::JSONB,$5::JSONB,$6::JSONB,$7::JSONB,$8,$9,$10,$11)
     ON CONFLICT (account_id)
     DO UPDATE SET
       enabled=EXCLUDED.enabled,
       features=EXCLUDED.features,
       project_defaults=EXCLUDED.project_defaults,
       ai_limits=EXCLUDED.ai_limits,
       usage_limits=EXCLUDED.usage_limits,
       dedicated_hosts=EXCLUDED.dedicated_hosts,
       reason=EXCLUDED.reason,
       expires_at=EXCLUDED.expires_at,
       updated_by=EXCLUDED.updated_by,
       updated_at=EXCLUDED.updated_at`,
    [
      account_id,
      opts?.enabled ?? true,
      opts?.features ?? {},
      opts?.project_defaults ?? {},
      opts?.ai_limits ?? {},
      opts?.usage_limits ?? {},
      opts?.dedicated_hosts ?? {},
      opts?.reason ?? "test override",
      opts?.expires_at ?? null,
      opts?.updated_by ?? uuid(),
      opts?.updated_at ?? new Date(),
    ],
  );
}

export async function createTestAdminAssignedMembership(
  account_id: string,
  opts: {
    membership_class: MembershipClass;
    assigned_by?: string;
    assigned_at?: Date;
    expires_at?: Date | null;
    notes?: string | null;
  },
) {
  const pool = getPool("medium");
  const assigned_by = opts.assigned_by ?? uuid();
  const assigned_at = opts.assigned_at ?? new Date();
  const expires_at = opts.expires_at ?? null;
  await pool.query(
    `INSERT INTO admin_assigned_memberships (
      account_id,
      membership_class,
      assigned_by,
      assigned_at,
      expires_at,
      notes
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (account_id)
    DO UPDATE SET
      membership_class=EXCLUDED.membership_class,
      assigned_by=EXCLUDED.assigned_by,
      assigned_at=EXCLUDED.assigned_at,
      expires_at=EXCLUDED.expires_at,
      notes=EXCLUDED.notes`,
    [
      account_id,
      opts.membership_class,
      assigned_by,
      assigned_at,
      expires_at,
      opts.notes ?? null,
    ],
  );
}

export async function createTestMembershipGrant(
  account_id: string,
  opts: {
    membership_class: MembershipClass;
    source?: string;
    package_id?: string | null;
    purchase_id?: number | null;
    granted_by_account_id?: string | null;
    starts_at?: Date | null;
    expires_at?: Date | null;
    revoked_at?: Date | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  const pool = getPool("medium");
  await pool.query(
    `INSERT INTO membership_grants (
      id,
      account_id,
      membership_class,
      source,
      package_id,
      purchase_id,
      granted_by_account_id,
      starts_at,
      expires_at,
      revoked_at,
      metadata,
      created,
      updated
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::JSONB,NOW(),NOW())`,
    [
      uuid(),
      account_id,
      opts.membership_class,
      opts.source ?? "test-grant",
      opts.package_id ?? null,
      opts.purchase_id ?? null,
      opts.granted_by_account_id ?? null,
      opts.starts_at ?? new Date(),
      opts.expires_at ?? null,
      opts.revoked_at ?? null,
      opts.metadata ?? null,
    ],
  );
}

export async function createTestMembershipPackage(opts: {
  owner_account_id: string;
  kind: "course" | "team" | "domain" | "site";
  membership_class: MembershipClass;
  seat_count: number;
  purchase_id?: number | null;
  starts_at?: Date | null;
  expires_at?: Date | null;
  metadata?: Record<string, unknown> | null;
}) {
  const pool = getPool("medium");
  const id = uuid();
  await pool.query(
    `INSERT INTO membership_packages (
      id,
      owner_account_id,
      kind,
      membership_class,
      seat_count,
      purchase_id,
      starts_at,
      expires_at,
      metadata,
      created,
      updated
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::JSONB,NOW(),NOW())`,
    [
      id,
      opts.owner_account_id,
      opts.kind,
      opts.membership_class,
      opts.seat_count,
      opts.purchase_id ?? null,
      opts.starts_at ?? new Date(),
      opts.expires_at ?? null,
      opts.metadata ?? null,
    ],
  );
  return id;
}
