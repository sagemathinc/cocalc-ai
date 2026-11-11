/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  mergeProjectHostMetadataObject,
  upsertProjectHost,
} from "./project-hosts";

const HOST_ID = "7a1e7841-a2d0-461f-83f0-6f1dcc44174a";

describe("upsertProjectHost", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15_000);

  afterAll(async () => {
    await testCleanup();
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM project_hosts WHERE id=$1", [HOST_ID]);
  });

  it("keeps a bay-seeded self_host and local-proxy keys (the Star seed path) across a later observation", async () => {
    // scripts/star-poc/seed-star-poc.cjs writes these bay-side through this
    // function; host reports have them stripped before they get here (054 C).
    await upsertProjectHost({
      id: HOST_ID,
      bay_id: "bay-0",
      status: "running",
      internal_url: "http://127.0.0.1:9002",
      metadata: {
        provider: "star",
        cloud_provider: "star",
        local: true,
        machine: { cloud: "self-host", metadata: { self_host_mode: "local" } },
        self_host: { http_tunnel_port: 9002, ssh_tunnel_port: 2222 },
      },
    });
    // a later host observation, already stripped of the denied keys
    await upsertProjectHost({
      id: HOST_ID,
      status: "running",
      metadata: { host_session_id: "s1", software: { project_host: "1.0.0" } },
    });
    const { rows } = await getPool().query(
      "SELECT metadata FROM project_hosts WHERE id=$1",
      [HOST_ID],
    );
    const md = rows[0]?.metadata;
    expect(md.self_host).toEqual({ http_tunnel_port: 9002, ssh_tunnel_port: 2222 });
    expect(md.provider).toBe("star");
    expect(md.cloud_provider).toBe("star");
    expect(md.local).toBe(true);
    expect(md.machine).toEqual({
      cloud: "self-host",
      metadata: { self_host_mode: "local" },
    });
    expect(md.host_session_id).toBe("s1");
  });

  it("preserves hub-owned metadata across observations", async () => {
    await upsertProjectHost({
      id: HOST_ID,
      status: "running",
      metadata: {
        runtime_health: { status: "starting", ready: false },
        runtime_deployments: {
          planned_project_host_transition: { operation_id: "untrusted" },
        },
        public_route: { active_mode: "cloudflare-tunnel" },
        dns: { record_id: "untrusted-record" },
        cloudflare_tunnel: { id: "untrusted-tunnel" },
        content_dns: { name: "*.untrusted.example", record_id: "untrusted" },
      },
    });
    const { rows: inserted } = await getPool().query(
      "SELECT metadata FROM project_hosts WHERE id=$1",
      [HOST_ID],
    );
    expect(inserted[0]?.metadata.content_dns).toBeUndefined();

    await getPool().query(
      `UPDATE project_hosts
       SET metadata=jsonb_set(
         metadata,
         '{runtime_deployments}',
         $2::jsonb,
         true
       )
       WHERE id=$1`,
      [
        HOST_ID,
        JSON.stringify({
          planned_project_host_transition: {
            operation_id: "control-plane-operation",
          },
          pending_automatic_convergence_retry: { runtime: true },
        }),
      ],
    );
    await getPool().query(
      `UPDATE project_hosts
       SET metadata=metadata || $2::jsonb
       WHERE id=$1`,
      [
        HOST_ID,
        JSON.stringify({
          public_route: { active_mode: "cloudflare-proxy" },
          dns: { record_id: "control-plane-record" },
          cloudflare_tunnel: { id: "control-plane-tunnel" },
          content_dns: { name: "*.h-control.example", record_id: "control" },
        }),
      ],
    );

    await upsertProjectHost({
      id: HOST_ID,
      status: "running",
      metadata: {
        runtime_health: { status: "ready", ready: true },
        runtime_deployments: {
          planned_project_host_transition: { operation_id: "stale-host" },
        },
        public_route: { active_mode: "cloudflare-tunnel" },
        dns: { record_id: "stale-host-record" },
        cloudflare_tunnel: { id: "stale-host-tunnel" },
        content_dns: { name: "*.victim.example", record_id: "stale-host" },
      },
    });

    const { rows } = await getPool().query(
      "SELECT metadata FROM project_hosts WHERE id=$1",
      [HOST_ID],
    );
    expect(rows[0]?.metadata).toMatchObject({
      runtime_health: { status: "ready", ready: true },
      runtime_deployments: {
        planned_project_host_transition: {
          operation_id: "control-plane-operation",
        },
        pending_automatic_convergence_retry: { runtime: true },
      },
      public_route: { active_mode: "cloudflare-proxy" },
      dns: { record_id: "control-plane-record" },
      cloudflare_tunnel: { id: "control-plane-tunnel" },
      content_dns: { name: "*.h-control.example", record_id: "control" },
    });
  });

  it("atomically merges one metadata object without replacing siblings", async () => {
    await upsertProjectHost({
      id: HOST_ID,
      status: "running",
      metadata: {
        bootstrap: {
          status: "running",
          message: "Bootstrap is running",
        },
      },
    });
    await getPool().query(
      `UPDATE project_hosts
          SET metadata=metadata || $2::jsonb
        WHERE id=$1`,
      [
        HOST_ID,
        JSON.stringify({
          public_route: { active_mode: "cloudflare-proxy" },
          dns: { record_id: "control-plane-record" },
          cloudflare_tunnel: { id: "control-plane-tunnel" },
        }),
      ],
    );

    await mergeProjectHostMetadataObject({
      id: HOST_ID,
      field: "bootstrap",
      patch: {
        status: "done",
        updated_at: "2026-07-21T20:00:00.000Z",
      },
    });

    const { rows } = await getPool().query(
      "SELECT metadata FROM project_hosts WHERE id=$1",
      [HOST_ID],
    );
    expect(rows[0]?.metadata).toEqual({
      bootstrap: {
        status: "done",
        message: "Bootstrap is running",
        updated_at: "2026-07-21T20:00:00.000Z",
      },
      public_route: { active_mode: "cloudflare-proxy" },
      dns: { record_id: "control-plane-record" },
      cloudflare_tunnel: { id: "control-plane-tunnel" },
    });
  });
});
