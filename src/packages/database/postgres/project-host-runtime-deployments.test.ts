/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import {
  listProjectHostRuntimeDeployments,
  loadEffectiveProjectHostRuntimeDeployments,
  setProjectHostRuntimeDeployments,
} from "./project-host-runtime-deployments";

describe("project host runtime deployments", () => {
  async function insertProjectHost(host_id: string): Promise<void> {
    await getPool().query(
      "INSERT INTO project_hosts (id, name, created, updated) VALUES ($1, $2, NOW(), NOW())",
      [host_id, `host-${host_id.slice(0, 8)}`],
    );
  }

  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query("DELETE FROM project_host_runtime_deployments");
    await getPool().query("DELETE FROM project_hosts");
  });

  afterAll(async () => {
    await testCleanup();
  });

  it("merges global defaults with host overrides", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);

    await setProjectHostRuntimeDeployments({
      scope_type: "global",
      requested_by: "acct-global",
      deployments: [
        {
          target_type: "component",
          target: "acp-worker",
          desired_version: "project-host-v1",
          rollout_policy: "drain_then_replace",
          drain_deadline_seconds: 12 * 60 * 60,
        },
        {
          target_type: "artifact",
          target: "project-bundle",
          desired_version: "project-bundle-v1",
        },
      ],
    });

    await setProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id,
      requested_by: "acct-host",
      deployments: [
        {
          target_type: "component",
          target: "acp-worker",
          desired_version: "project-host-v2",
          rollout_reason: "canary",
        },
      ],
    });

    const configuredHost = await listProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id,
    });
    expect(configuredHost).toHaveLength(1);
    expect(configuredHost[0].desired_version).toBe("project-host-v2");
    expect(configuredHost[0].scope_type).toBe("host");

    const effective = await loadEffectiveProjectHostRuntimeDeployments({
      host_id,
    });
    expect(effective).toHaveLength(2);
    expect(effective).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope_type: "host",
          host_id,
          target_type: "component",
          target: "acp-worker",
          desired_version: "project-host-v2",
        }),
        expect.objectContaining({
          scope_type: "global",
          host_id: undefined,
          target_type: "artifact",
          target: "project-bundle",
          desired_version: "project-bundle-v1",
        }),
      ]),
    );
  });

  it("can replace a scope without touching other scopes", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);

    await setProjectHostRuntimeDeployments({
      scope_type: "global",
      requested_by: "acct-global",
      deployments: [
        {
          target_type: "artifact",
          target: "tools",
          desired_version: "tools-v1",
        },
      ],
    });

    await setProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id,
      requested_by: "acct-host",
      deployments: [
        {
          target_type: "component",
          target: "conat-router",
          desired_version: "project-host-v1",
          rollout_policy: "restart_now",
        },
      ],
    });

    await setProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id,
      requested_by: "acct-host",
      replace: true,
      deployments: [
        {
          target_type: "component",
          target: "acp-worker",
          desired_version: "project-host-v2",
        },
      ],
    });

    const hostRows = await listProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id,
    });
    expect(hostRows).toHaveLength(1);
    expect(hostRows[0].target).toBe("acp-worker");

    const effective = await loadEffectiveProjectHostRuntimeDeployments({
      host_id,
    });
    expect(effective).toHaveLength(2);
    expect(effective).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_type: "component",
          target: "acp-worker",
          desired_version: "project-host-v2",
        }),
        expect.objectContaining({
          target_type: "artifact",
          target: "tools",
          desired_version: "tools-v1",
        }),
      ]),
    );
  });
});
