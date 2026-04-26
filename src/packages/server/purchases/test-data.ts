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
  usage_limits?: Record<string, unknown>;
}) {
  const pool = getPool("medium");
  await pool.query(
    `INSERT INTO membership_tiers
      (id, label, store_visible, priority, price_monthly, price_yearly,
       project_defaults, llm_limits, features, usage_limits,
       disabled, notes, history, created, updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8::JSONB,$9::JSONB,$10::JSONB,$11,$12,$13::JSONB,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       label=EXCLUDED.label,
       store_visible=EXCLUDED.store_visible,
       priority=EXCLUDED.priority,
       price_monthly=EXCLUDED.price_monthly,
       price_yearly=EXCLUDED.price_yearly,
       project_defaults=EXCLUDED.project_defaults,
       llm_limits=EXCLUDED.llm_limits,
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
      {},
      {},
      {},
      opts.usage_limits ?? {},
      false,
      null,
      [],
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
