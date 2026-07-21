/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { upsertProjectHost } from "@cocalc/database/postgres/project-hosts";
import { after, before, getPool } from "@cocalc/server/test";
import { _test } from "./runtime-maintenance";

const HOST_A = "dab25958-64df-4bea-803b-77319d7839f6";
const HOST_B = "12869982-da11-495e-9914-ee784ee8d5a8";

function probe(claim_id: string) {
  return {
    status: "failed",
    claim_id,
    quarantined: true,
    consecutive_failures: 2,
    origin_health: { status: "healthy" },
  };
}

function failure(host_id: string, probe_claim_id: string) {
  return {
    row: {
      id: host_id,
      status: "running",
      last_seen: new Date(),
      metadata: { cloudflared_restart_supported: true },
    },
    error: "2/8 public project-host WebSocket upgrades failed",
    consecutive_failures: 2,
    probe: probe(probe_claim_id),
  };
}

async function insertHost({
  host_id,
  probe_claim_id,
  recovery,
  public_route,
}: {
  host_id: string;
  probe_claim_id: string;
  recovery?: Record<string, any>;
  public_route?: Record<string, any>;
}) {
  await upsertProjectHost({
    id: host_id,
    bay_id: "bay-0",
    name: `test-${host_id}`,
    status: "running",
    last_seen: new Date(),
    metadata: {
      desired_state: "running",
      cloudflared_restart_supported: true,
      public_route_probe: probe(probe_claim_id),
      ...(recovery ? { public_route_auto_recovery: recovery } : {}),
    },
  });
  if (public_route) {
    await getPool().query(
      `UPDATE project_hosts
       SET metadata=jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{public_route}',
         $2::jsonb,
         true
       )
       WHERE id=$1`,
      [host_id, JSON.stringify(public_route)],
    );
  }
}

describe("public-route automatic repair claims", () => {
  beforeAll(async () => {
    await before({ noConat: true });
  }, 15_000);

  afterAll(after);

  beforeEach(async () => {
    await getPool().query("DELETE FROM project_hosts WHERE id=ANY($1)", [
      [HOST_A, HOST_B],
    ]);
  });

  it("keeps an expired uncertain claim in cooldown before allowing another fleet claim", async () => {
    const now = Date.now();
    await insertHost({
      host_id: HOST_A,
      probe_claim_id: "probe-a",
      recovery: {
        status: "claiming",
        claim_id: "stale-claim",
        attempted_at: new Date(now - 3 * 60_000).toISOString(),
        claim_expires_at: new Date(now - 60_000).toISOString(),
      },
    });

    await expect(
      _test.claimPublicRouteAutoRepair(failure(HOST_A, "probe-a")),
    ).resolves.toBeUndefined();

    await getPool().query(
      `UPDATE project_hosts
       SET metadata=jsonb_set(
         metadata,
         '{public_route_auto_recovery,attempted_at}',
         to_jsonb($2::text)
       )
       WHERE id=$1`,
      [HOST_A, new Date(now - 31 * 60_000).toISOString()],
    );

    const claimId = await _test.claimPublicRouteAutoRepair(
      failure(HOST_A, "probe-a"),
    );
    expect(claimId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const { rows } = await getPool().query(
      `SELECT metadata -> 'public_route_auto_recovery' AS recovery
       FROM project_hosts WHERE id=$1`,
      [HOST_A],
    );
    expect(rows[0]?.recovery).toMatchObject({
      status: "claiming",
      claim_id: claimId,
      probe_claim_id: "probe-a",
      consecutive_failures: 2,
    });

    await insertHost({ host_id: HOST_B, probe_claim_id: "probe-b" });
    await expect(
      _test.claimPublicRouteAutoRepair(failure(HOST_B, "probe-b")),
    ).resolves.toBeUndefined();
  });

  it("does not claim tunnel repair for a direct public route", async () => {
    await insertHost({
      host_id: HOST_A,
      probe_claim_id: "probe-direct",
      public_route: { active_mode: "cloudflare-proxy", status: "active" },
    });

    await expect(
      _test.claimPublicRouteAutoRepair(failure(HOST_A, "probe-direct")),
    ).resolves.toBeUndefined();
  });

  it("keeps the six most recent tunnel recovery incidents", async () => {
    const claimId = "8f4b5e51-670b-49d2-b970-976c1b2917b1";
    await insertHost({
      host_id: HOST_A,
      probe_claim_id: "probe-history",
      recovery: {
        status: "claiming",
        claim_id: claimId,
        attempted_at: new Date().toISOString(),
      },
    });

    for (let sequence = 0; sequence < 8; sequence++) {
      await _test.updatePublicRouteAutoRecovery({
        host_id: HOST_A,
        claim_id: claimId,
        state: {
          status: "restart_completed",
          claim_id: claimId,
          sequence,
        },
      });
    }

    const { rows } = await getPool().query(
      `SELECT metadata -> 'public_route_incidents' AS incidents
       FROM project_hosts WHERE id=$1`,
      [HOST_A],
    );
    expect(rows[0]?.incidents).toHaveLength(6);
    expect(rows[0]?.incidents.map(({ sequence }) => sequence)).toEqual([
      7, 6, 5, 4, 3, 2,
    ]);
  });
});
