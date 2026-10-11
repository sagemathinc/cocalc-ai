/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PostgreSQL } from "../types";

interface WhenSentProjectInviteOptions {
  project_id: string;
  to: string; // email address
}

interface SentProjectInviteOptions {
  project_id: string;
  to: string; // email address
  error?: string; // if there was an error, set it to this; leave undefined to mean sending succeeded
}

/**
 * Check if an invite has been successfully sent to a given email address for a project.
 *
 * Returns:
 * - Date object with the timestamp when the invite was sent (if sent successfully)
 * - 0 if no invite was sent, or if the invite had an error, or if no time was recorded
 */
export async function whenSentProjectInvite(
  db: PostgreSQL,
  opts: WhenSentProjectInviteOptions,
): Promise<Date | number> {
  const valid = db._validate_opts(opts);
  if (!valid) {
    throw new Error("Invalid options");
  }

  // Sanitize email address for JSONB path query
  // This handles special characters in emails like quotes
  const sani_to = db.sanitize(`{"${opts.to}"}`);

  // Query the invite JSONB field for this specific email
  const query_select = `SELECT invite#>${sani_to} AS to FROM projects`;

  const result = await db.async_query({
    query: query_select,
    where: { "project_id :: UUID = $": opts.project_id },
  });

  // Process result using one_result pattern
  if (!result.rows || result.rows.length === 0) {
    return 0;
  }

  const y = result.rows[0]?.to;

  // Return 0 if: no result, or error exists, or no time recorded
  if (!y || y.error || !y.time) {
    return 0;
  }

  // Return the timestamp as a Date object
  return new Date(y.time);
}

/**
 * Record that an email invite has been sent (or attempted) for a project.
 *
 * This updates the projects.invite JSONB field to track:
 * - time: when the invite was sent
 * - error: any error that occurred (undefined if successful)
 *
 * Multiple invites for different emails are tracked in the same JSONB field.
 */
export async function sentProjectInvite(
  _db: PostgreSQL,
  opts: SentProjectInviteOptions,
): Promise<void> {
  // Replace this address's entry, which also clears an in-flight send claim
  // (claimed_at) taken by claimProjectInviteSend. Other addresses are kept.
  const entry: { time: Date; error?: string } = { time: new Date() };
  if (opts.error) entry.error = opts.error;
  await getPool().query(
    `UPDATE projects
        SET invite = jsonb_set(
              COALESCE(invite, '{}'::jsonb),
              ARRAY[$2::text],
              $3::jsonb,
              true
            )
      WHERE project_id = $1::uuid`,
    [opts.project_id, opts.to, JSON.stringify(entry)],
  );
}

export interface ClaimProjectInviteSendOptions {
  project_id: string;
  to: string;
  cutoff: Date;
}

// How long an unfinished send claim blocks other senders (crash safety).
export const INVITE_SEND_CLAIM_LEASE_MINUTES = 10;

// Atomically claim the right to email an invite to `to` for this project.
// Two independent conditions must hold:
//  - no other send is in flight: no claimed_at newer than the lease, which
//    blocks concurrent senders even with a zero-minute resend cooldown;
//  - the resend cooldown allows it: no successful send since `cutoff`, or
//    the last attempt recorded an error.
// Concurrent callers serialize on the project row, so exactly one wins.
// The claim also records time (and drops any error) so that it looks like a
// recent send to whenSentProjectInvite: servers running older code, which
// only check that, fail closed during a rolling upgrade, and a send that
// went out but was never finalized still counts against the cooldown.
// Finish with sentProjectInvite (success, or an error to allow a retry),
// which clears the claim.
export async function claimProjectInviteSend(
  _db: PostgreSQL,
  opts: ClaimProjectInviteSendOptions,
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE projects
        SET invite = jsonb_set(
              COALESCE(invite, '{}'::jsonb),
              ARRAY[$2::text],
              jsonb_build_object(
                'time', to_jsonb(NOW()),
                'claimed_at', to_jsonb(NOW())
              ),
              true
            )
      WHERE project_id = $1::uuid
        AND (
          invite -> $2::text -> 'claimed_at' IS NULL
          OR (invite -> $2::text ->> 'claimed_at')::timestamptz
               < NOW() - make_interval(mins => $4::int)
        )
        AND (
          invite -> $2::text -> 'time' IS NULL
          OR COALESCE(invite -> $2::text ->> 'error', '') <> ''
          OR (invite -> $2::text ->> 'time')::timestamptz < $3::timestamptz
        )`,
    [opts.project_id, opts.to, opts.cutoff, INVITE_SEND_CLAIM_LEASE_MINUTES],
  );
  return (rowCount ?? 0) > 0;
}
