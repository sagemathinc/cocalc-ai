/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { after, before, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { createLro, updateLro } from "@cocalc/server/lro/lro-db";
import { setProjectHostRuntimeDeployments } from "@cocalc/database/postgres/project-host-runtime-deployments";
import type { ManagedComponentKind } from "@cocalc/conat/project-host/api";
import {
  fleetCampaignSupersededReason,
  HOST_RUNTIME_FLEET_ROLLOUT_KIND,
} from "./runtime-fleet-supersession";

beforeAll(async () => {
  await before();
  await getPool().query(`CREATE TABLE IF NOT EXISTS project_hosts (
    id UUID PRIMARY KEY, bay_id TEXT, status TEXT, last_seen TIMESTAMP,
    deleted TIMESTAMP, metadata JSONB, public_url TEXT, internal_url TEXT
  )`);
}, 15_000);
afterAll(after);

async function host(): Promise<string> {
  const id = uuid();
  await getPool().query(
    "INSERT INTO project_hosts (id, status) VALUES ($1, 'running')",
    [id],
  );
  return id;
}

async function campaign({
  version,
  components,
  host_ids,
}: {
  version: string;
  components: ManagedComponentKind[];
  host_ids: string[];
}) {
  const op = await createLro({
    kind: HOST_RUNTIME_FLEET_ROLLOUT_KIND,
    scope_type: "hub",
    scope_id: uuid(),
    input: { version, components, host_ids },
  });
  await updateLro({
    op_id: op.op_id,
    status: "failed",
    progress_summary: { phase: "paused" },
  });
  return op;
}

async function setDeployment({
  host_id,
  target_type,
  target,
  desired_version,
}: {
  host_id?: string;
  target_type: "artifact" | "component";
  target: string;
  desired_version: string;
}) {
  await setProjectHostRuntimeDeployments({
    scope_type: host_id ? "host" : "global",
    host_id,
    requested_by: uuid(),
    deployments: [{ target_type, target: target as any, desired_version }],
  });
}

describe("fleet campaign supersession", () => {
  // Each case pauses its campaign first and is checked before a newer
  // campaign exists, so the newer-campaign rule does not mask it.
  it("a global change to any selected component supersedes a component-only campaign", async () => {
    const [done, pending] = [await host(), await host()];
    const op = await campaign({
      version: "v1",
      components: ["conat-router"],
      host_ids: [done, pending],
    });
    const check = () =>
      fleetCampaignSupersededReason({
        op_id: op.op_id,
        version: "v1",
        components: ["conat-router"],
        host_ids: [done, pending],
        completed_host_ids: [done],
      });
    await expect(check()).resolves.toBeUndefined();
    // Rows the campaign wrote itself: the finished host, and a host row at
    // the campaign's own version.
    await setDeployment({
      host_id: done,
      target_type: "component",
      target: "conat-router",
      desired_version: "v-other",
    });
    await setDeployment({
      host_id: pending,
      target_type: "component",
      target: "conat-router",
      desired_version: "v1",
    });
    // An unrelated target does not matter.
    await setDeployment({
      target_type: "component",
      target: "acp-worker",
      desired_version: "v2",
    });
    await expect(check()).resolves.toBeUndefined();
    await setDeployment({
      target_type: "component",
      target: "conat-router",
      desired_version: "v2",
    });
    await expect(check()).resolves.toMatch(
      /global default for component:conat-router changed to v2/,
    );
  });

  it("a new override on a host it has not finished supersedes it", async () => {
    const pending = await host();
    const op = await campaign({
      version: "v1",
      components: ["project-host"],
      host_ids: [pending],
    });
    const check = () =>
      fleetCampaignSupersededReason({
        op_id: op.op_id,
        version: "v1",
        components: ["project-host"],
        host_ids: [pending],
        completed_host_ids: [],
      });
    await expect(check()).resolves.toBeUndefined();
    await setDeployment({
      host_id: pending,
      target_type: "artifact",
      target: "project-host",
      desired_version: "v-pinned",
    });
    await expect(check()).resolves.toMatch(
      new RegExp(
        `host ${pending} for artifact:project-host changed to v-pinned`,
      ),
    );
  });

  it("a newer campaign supersedes an older one", async () => {
    const h = await host();
    const older = await campaign({
      version: "v1",
      components: ["project-host"],
      host_ids: [h],
    });
    const newer = await campaign({
      version: "v3",
      components: ["project-host"],
      host_ids: [h],
    });
    const check = (op_id: string, version: string) =>
      fleetCampaignSupersededReason({
        op_id,
        version,
        components: ["project-host"],
        host_ids: [h],
        completed_host_ids: [],
      });
    await expect(check(older.op_id, "v1")).resolves.toMatch(
      new RegExp(`newer fleet rollout ${newer.op_id}`),
    );
    await expect(check(newer.op_id, "v3")).resolves.toBeUndefined();
  });
});
