/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import {
  REFRESH_TURN_GRANT_SQL,
  requireAgentComputeGrant,
} from "./turn-grants";

beforeAll(async () => {
  await before({ noConat: true });
}, 60_000);
afterAll(after);

const fingerprint = () =>
  randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

async function insertGrant({
  secret_hash,
  account_id,
  project_id,
  createdAgo,
  expiresIn,
}: {
  secret_hash: string;
  account_id: string;
  project_id: string;
  createdAgo: string;
  expiresIn: string;
}) {
  await getPool().query(
    `INSERT INTO compute_vm_turn_grants (
       grant_id, secret_hash, owner_account_id, project_id, turn_id,
       session_id, issued_by_account_id, allowed_actions, allowed_vm_ids,
       allow_create, allowed_providers, allowed_machine_classes,
       funding_mode, max_active_vms, max_hourly_usd,
       max_total_authorized_usd, max_ttl_minutes, expires_at,
       created_at, metadata
     ) VALUES (
       $1,$2,$3,$4,'turn','turn',$3,ARRAY['read','data-plane']::text[],
       '{}'::uuid[],false,ARRAY['gcp']::text[],ARRAY[]::text[],NULL,0,0,0,0,
       NOW() + $6::interval, NOW() - $5::interval, '{}'::jsonb
     )`,
    [randomUUID(), secret_hash, account_id, project_id, createdAgo, expiresIn],
  );
}

async function expiresInSeconds(secret_hash: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT EXTRACT(EPOCH FROM (expires_at - NOW()))::float AS s
       FROM compute_vm_turn_grants WHERE secret_hash=$1`,
    [secret_hash],
  );
  return Number(rows[0].s);
}

describe("refreshing a turn grant", () => {
  it("keeps extending a long agent session's grant with each fresh credential", async () => {
    const account_id = randomUUID();
    const project_id = randomUUID();
    const secret_hash = fingerprint();
    // created two hours ago, still alive because the session kept refreshing
    await insertGrant({
      secret_hash,
      account_id,
      project_id,
      createdAgo: "2 hours",
      expiresIn: "5 minutes",
    });
    const now = Math.floor(Date.now() / 1000);
    await requireAgentComputeGrant({
      auth: {
        account_id,
        project_id,
        token_fingerprint: secret_hash,
        issued_at_s: now,
        expires_at_s: now + 600,
      },
      action: "read",
      project_id,
    });
    const left = await expiresInSeconds(secret_hash);
    expect(left).toBeGreaterThan(590);
    expect(left).toBeLessThanOrEqual(600);
  });

  it("never moves a grant's expiry more than 31 minutes past now", async () => {
    const account_id = randomUUID();
    const project_id = randomUUID();
    const secret_hash = fingerprint();
    await insertGrant({
      secret_hash,
      account_id,
      project_id,
      createdAgo: "1 minute",
      expiresIn: "5 minutes",
    });
    const now = Math.floor(Date.now() / 1000);
    // the longest credential that passes validation: issued 60 s ahead,
    // living the full 30 minutes
    await requireAgentComputeGrant({
      auth: {
        account_id,
        project_id,
        token_fingerprint: secret_hash,
        issued_at_s: now + 60,
        expires_at_s: now + 60 + 1800,
      },
      action: "read",
      project_id,
    });
    expect(await expiresInSeconds(secret_hash)).toBeLessThanOrEqual(31 * 60);
  });

  it("caps the refresh itself at 31 minutes past now", async () => {
    const secret_hash = fingerprint();
    await insertGrant({
      secret_hash,
      account_id: randomUUID(),
      project_id: randomUUID(),
      createdAgo: "1 minute",
      expiresIn: "5 minutes",
    });
    // an expiry no valid credential has: reaches the cap only without the
    // credential lifetime check in front of it
    await getPool().query(REFRESH_TURN_GRANT_SQL, [
      secret_hash,
      new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000),
    ]);
    const left = await expiresInSeconds(secret_hash);
    expect(left).toBeGreaterThan(30 * 60);
    expect(left).toBeLessThanOrEqual(31 * 60);
  });

  it("refuses a credential that claims a longer life than any token has", async () => {
    const account_id = randomUUID();
    const project_id = randomUUID();
    const secret_hash = fingerprint();
    await insertGrant({
      secret_hash,
      account_id,
      project_id,
      createdAgo: "1 minute",
      expiresIn: "5 minutes",
    });
    const now = Math.floor(Date.now() / 1000);
    await expect(
      requireAgentComputeGrant({
        auth: {
          account_id,
          project_id,
          token_fingerprint: secret_hash,
          issued_at_s: now,
          expires_at_s: now + 10 * 365 * 24 * 3600,
        },
        action: "read",
        project_id,
      }),
    ).rejects.toMatchObject({ code: 403 });
    // and the grant was not touched
    const left = await expiresInSeconds(secret_hash);
    expect(left).toBeLessThanOrEqual(5 * 60);
  });
});
