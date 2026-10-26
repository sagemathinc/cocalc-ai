/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const calls: string[] = [];
const statuses: any[] = [];

jest.mock("@cocalc/server/conat/api/hosts-routed", () => ({
  upgradeHostSoftware: jest.fn(async () => {
    calls.push("upgrade project-host");
    return { op_id: "upgrade", scope_type: "host", scope_id: "h" };
  }),
  rolloutHostManagedComponents: jest.fn(async ({ components }) => {
    calls.push(`rollout ${components.join(",")}`);
    return { op_id: "components", scope_type: "host", scope_id: "h" };
  }),
  getHostRuntimeDeploymentStatus: jest.fn(async () => {
    const status = statuses.length > 1 ? statuses.shift() : statuses[0];
    calls.push(`status ${status.label}`);
    return status;
  }),
  waitForHostLro: jest.fn(async () => ({ status: "succeeded" })),
}));
jest.mock("@cocalc/server/lro/wait", () => ({
  waitForDurableLroCompletion: jest.fn(async () => ({ status: "succeeded" })),
}));
jest.mock("@cocalc/backend/conat", () => ({ conat: () => ({}) }));

import { __test__ } from "./runtime-fleet-rollout-worker";
import { after, before } from "@cocalc/server/test";

const OLD = "20261008T055708Z-b80990bb-release-20261008-r1";
const NEW = "20261011T050345Z-447cc4e4-release-20261011-r1";
const AUX = ["conat-router", "conat-persist", "acp-worker"] as const;

function status(label: string, projectHost: string, aux: string) {
  return {
    label,
    observed_artifacts: [
      { artifact: "project-host", current_version: projectHost },
    ],
    observed_components: [
      {
        component: "project-host",
        runtime_state: "running",
        version_state: projectHost === NEW ? "aligned" : "drifted",
        running_versions: [projectHost],
      },
      ...AUX.map((component) => ({
        component,
        runtime_state: "running",
        version_state: aux === NEW ? "aligned" : "drifted",
        desired_version: NEW,
        running_versions: [aux],
      })),
    ],
    observed_host_agent: {
      project_host: {
        rollout: {
          target_version: NEW,
          running_version: projectHost,
          healthy: projectHost === NEW,
          phase: projectHost === NEW ? "promoted" : "restarting",
        },
      },
    },
  };
}

function rollout(components: string[]) {
  return __test__.runHostRollout({
    account_id: "account",
    host_id: "host",
    version: NEW,
    components: components as any,
    stabilize_seconds: 0,
    shouldCancel: async () => false,
  });
}

describe("rolling one host", () => {
  // Advancing the clock also fires timers of imported services that query
  // the database.
  beforeAll(async () => {
    await before({ noConat: true });
  }, 15000);
  afterAll(after);

  beforeEach(() => {
    calls.length = 0;
    statuses.length = 0;
    // Only the rollout's own waits: intervals belong to imported services.
    jest.useFakeTimers({
      doNotFake: ["setInterval", "clearInterval", "setImmediate", "nextTick"],
    });
  });
  afterEach(() => jest.useRealTimers());

  test("rolls the other components only after the host reports the new project-host", async () => {
    statuses.push(
      status("restarting", OLD, OLD),
      status("project-host up", NEW, OLD),
      status("all new", NEW, NEW),
    );
    const done = rollout(["project-host", ...AUX]);
    await jest.advanceTimersByTimeAsync(10_000);
    const result = await done;
    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([
      "upgrade project-host",
      "status restarting",
      "status project-host up",
      `rollout ${AUX.join(",")}`,
      "status all new",
    ]);
  });

  test("fails the host when project-host never reports the new version", async () => {
    statuses.push(status("restarting", OLD, OLD));
    const done = rollout(["project-host", ...AUX]);
    await jest.advanceTimersByTimeAsync(4 * 60_000);
    const result = await done;
    expect(result.status).toBe("failed");
    expect(calls).not.toContain(`rollout ${AUX.join(",")}`);
  });

  test("adds no wait when only project-host or only other components roll", async () => {
    statuses.push(status("all new", NEW, NEW));
    expect((await rollout(["project-host"])).status).toBe("succeeded");
    expect(calls).toEqual(["upgrade project-host", "status all new"]);
    calls.length = 0;
    expect((await rollout([...AUX])).status).toBe("succeeded");
    expect(calls).toEqual([`rollout ${AUX.join(",")}`, "status all new"]);
  });
});
