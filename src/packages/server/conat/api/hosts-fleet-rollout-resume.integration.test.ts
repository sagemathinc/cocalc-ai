/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { createLro, updateLro } from "@cocalc/server/lro/lro-db";
import { promoteProjectHostRuntimeDeployments } from "@cocalc/database/postgres/project-host-runtime-deployments";
import { fleetRolloutSupersededReason } from "./hosts";

beforeAll(async () => {
  await before();
}, 15_000);
afterAll(after);

const KIND = "host-runtime-fleet-rollout";

async function campaign(version: string) {
  const op = await createLro({
    kind: KIND,
    scope_type: "hub",
    scope_id: uuid(),
    input: { version, host_ids: [uuid()] },
  });
  await updateLro({
    op_id: op.op_id,
    status: "failed",
    progress_summary: { phase: "paused" },
  });
  return op;
}

async function setGlobalProjectHost(version: string) {
  await promoteProjectHostRuntimeDeployments({
    host_ids: [],
    requested_by: uuid(),
    deployments: [
      {
        target_type: "artifact",
        target: "project-host",
        desired_version: version,
      },
    ],
  });
}

describe("resuming a paused fleet rollout", () => {
  it("is refused once the global default or a newer campaign supersedes it", async () => {
    const old = await campaign("ph-old");
    await expect(fleetRolloutSupersededReason(old)).resolves.toBeUndefined();

    // Re-promoting the campaign's own version does not supersede it.
    await setGlobalProjectHost("ph-old");
    await expect(fleetRolloutSupersededReason(old)).resolves.toBeUndefined();

    await setGlobalProjectHost("ph-new");
    await expect(fleetRolloutSupersededReason(old)).resolves.toMatch(
      /global project-host default changed to ph-new/,
    );

    const other = await campaign("ph-old");
    await setGlobalProjectHost("ph-old");
    const newer = await campaign("ph-newer");
    await expect(fleetRolloutSupersededReason(other)).resolves.toMatch(
      new RegExp(`newer fleet rollout ${newer.op_id}`),
    );
    // The newest campaign itself is still resumable.
    await expect(fleetRolloutSupersededReason(newer)).resolves.toBeUndefined();
  });
});
