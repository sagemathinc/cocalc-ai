/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { PoolClient } from "@cocalc/database/pool";
import { canonicalEmailForBanEquivalence } from "@cocalc/server/accounts/cluster-directory";
import { is_valid_email_address as isValidEmailAddress } from "@cocalc/util/misc";

export interface MembershipTrialCandidate {
  trial_days: number;
  trial_available: boolean;
  trial_email?: string;
  trial_reason?: string;
}

export function normalizeTrialDays(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeEmailAddress(email: unknown): string | undefined {
  const value = `${email ?? ""}`.trim().toLowerCase();
  if (!value || !isValidEmailAddress(value)) return undefined;
  return value;
}

export function membershipTrialEmailKey(email: unknown): string | undefined {
  const normalized = normalizeEmailAddress(email);
  if (!normalized) return undefined;
  return canonicalEmailForBanEquivalence(normalized) ?? normalized;
}

async function ensureMembershipTrialClaimsTable(
  client?: PoolClient,
): Promise<void> {
  const pool = client ?? getPool("medium");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS membership_trial_claims (
      id SERIAL PRIMARY KEY,
      account_id UUID NOT NULL UNIQUE,
      email_address VARCHAR(254) NOT NULL UNIQUE,
      email_key VARCHAR(254),
      membership_class VARCHAR(254) NOT NULL,
      subscription_id INTEGER,
      purchase_id INTEGER,
      claimed_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE membership_trial_claims
      ADD COLUMN IF NOT EXISTS email_key VARCHAR(254)
  `);
  await pool.query(`
    UPDATE membership_trial_claims
       SET email_key=email_address
     WHERE email_key IS NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS membership_trial_claims_email_key_unique_idx
      ON membership_trial_claims (email_key)
  `);
}

export async function getMembershipTrialEmails({
  account_id,
  client,
}: {
  account_id: string;
  client?: PoolClient;
}): Promise<string[]> {
  const pool = client ?? getPool("medium");
  const { rows } = await pool.query(
    `SELECT email_address, email_address_verified
       FROM accounts
      WHERE account_id=$1
        AND (deleted IS NULL OR deleted=FALSE)
      LIMIT 1`,
    [account_id],
  );
  const row = rows[0];
  if (!row) {
    throw Error("account not found");
  }
  const emails = new Set<string>();
  const primary = normalizeEmailAddress(row.email_address);
  if (primary) {
    emails.add(primary);
  }
  const verified = row.email_address_verified ?? {};
  if (verified != null && typeof verified === "object") {
    for (const [email, value] of Object.entries(verified)) {
      if (value == null || value === false) continue;
      const normalized = normalizeEmailAddress(email);
      if (normalized) {
        emails.add(normalized);
      }
    }
  }
  return Array.from(emails).sort();
}

export async function getMembershipTrialCandidate({
  account_id,
  trial_days,
  client,
}: {
  account_id: string;
  trial_days: number;
  client?: PoolClient;
}): Promise<MembershipTrialCandidate> {
  const days = normalizeTrialDays(trial_days);
  if (days <= 0) {
    return { trial_days: 0, trial_available: false };
  }
  const emails = await getMembershipTrialEmails({ account_id, client });
  if (emails.length === 0) {
    return {
      trial_days: days,
      trial_available: false,
      trial_reason: "An email address is required for a free trial.",
    };
  }
  await ensureMembershipTrialClaimsTable(client);
  const pool = client ?? getPool("medium");
  const emailKeys = Array.from(
    new Set(
      emails.map((email) => membershipTrialEmailKey(email)).filter(Boolean),
    ),
  );
  const { rows } = await pool.query(
    `SELECT account_id, email_address, membership_class
       FROM membership_trial_claims
      WHERE account_id=$1
         OR email_address=ANY($2::varchar[])
         OR email_key=ANY($3::varchar[])
      LIMIT 1`,
    [account_id, emails, emailKeys],
  );
  if (rows.length > 0) {
    return {
      trial_days: days,
      trial_available: false,
      trial_reason: "A free membership trial was already used.",
    };
  }
  return {
    trial_days: days,
    trial_available: true,
    trial_email: emails[0],
  };
}

export async function claimMembershipTrial({
  account_id,
  email_address,
  membership_class,
  subscription_id,
  purchase_id,
  client,
}: {
  account_id: string;
  email_address: string;
  membership_class: string;
  subscription_id: number;
  purchase_id: number;
  client: PoolClient;
}): Promise<void> {
  const normalized = normalizeEmailAddress(email_address);
  if (!normalized) {
    throw Error("valid email address required for membership trial");
  }
  const emailKey = membershipTrialEmailKey(normalized) ?? normalized;
  await ensureMembershipTrialClaimsTable(client);
  try {
    await client.query(
      `INSERT INTO membership_trial_claims
         (account_id, email_address, email_key, membership_class, subscription_id, purchase_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        account_id,
        normalized,
        emailKey,
        membership_class,
        subscription_id,
        purchase_id,
      ],
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw Error("A free membership trial was already used.");
    }
    throw err;
  }
}
