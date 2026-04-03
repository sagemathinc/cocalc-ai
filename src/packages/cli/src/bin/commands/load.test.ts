import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { registerLoadCommand, type LoadCommandDeps } from "./load";

type Capture = {
  data?: any;
  accountBayCalls: number;
  listBayCalls: number;
  projectQueryCalls: number;
  lastLimit?: number;
};

function makeDeps(capture: Capture): LoadCommandDeps {
  return {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-4111-8111-111111111111",
        hub: {
          system: {
            getAccountBay: async () => {
              capture.accountBayCalls += 1;
              return { bay_id: "bay-0" };
            },
            listBays: async () => {
              capture.listBayCalls += 1;
              return [{ bay_id: "bay-0" }, { bay_id: "bay-1" }];
            },
          },
        },
      };
      capture.data = await fn(ctx);
    },
    queryProjects: async ({ limit }) => {
      capture.projectQueryCalls += 1;
      capture.lastLimit = limit;
      return [
        {
          project_id: "22222222-2222-4222-8222-222222222222",
          host_id: "host-1",
        },
      ];
    },
  };
}

test("load bootstrap summarizes repeated control-plane calls", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "bootstrap",
    "--iterations",
    "3",
    "--warmup",
    "1",
    "--concurrency",
    "2",
  ]);

  assert.equal(capture.accountBayCalls, 4);
  assert.equal(capture.listBayCalls, 4);
  assert.equal(capture.data.scenario, "bootstrap");
  assert.equal(capture.data.iterations, 3);
  assert.equal(capture.data.warmup, 1);
  assert.equal(capture.data.concurrency, 2);
  assert.equal(capture.data.successes, 3);
  assert.equal(capture.data.failures, 0);
  assert.equal(capture.data.last_result.home_bay_id, "bay-0");
  assert.equal(capture.data.last_result.visible_bay_count, 2);
  assert.ok(typeof capture.data.ops_per_sec === "number");
});

test("load projects respects the requested limit", async () => {
  const capture: Capture = {
    accountBayCalls: 0,
    listBayCalls: 0,
    projectQueryCalls: 0,
  };
  const program = new Command();
  registerLoadCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "load",
    "projects",
    "--iterations",
    "2",
    "--warmup",
    "1",
    "--concurrency",
    "4",
    "--limit",
    "25",
  ]);

  assert.equal(capture.projectQueryCalls, 3);
  assert.equal(capture.lastLimit, 25);
  assert.equal(capture.data.scenario, "projects");
  assert.equal(capture.data.iterations, 2);
  assert.equal(capture.data.warmup, 1);
  assert.equal(capture.data.concurrency, 3);
  assert.equal(capture.data.successes, 2);
  assert.equal(capture.data.failures, 0);
  assert.equal(
    capture.data.last_result.first_project_id,
    "22222222-2222-4222-8222-222222222222",
  );
});
