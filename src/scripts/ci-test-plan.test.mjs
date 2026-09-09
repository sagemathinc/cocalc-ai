import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlan,
  directlyChangedPackages,
  discoverWorkspaces,
  requiresFullSuite,
} from "./ci-test-plan.mjs";

const workspaces = discoverWorkspaces();

test("discovers nested test workspaces", () => {
  assert.ok(workspaces.some(({ name }) => name === "notebook"));
});

test("maps files to their most specific workspace", () => {
  assert.deepEqual(
    directlyChangedPackages(
      ["src/packages/apps/notebook/index.test.ts"],
      workspaces,
    ),
    ["notebook"],
  );
});

test("forces full coverage for shared test infrastructure", () => {
  assert.equal(requiresFullSuite(["src/workspaces.py"]), true);
  assert.equal(requiresFullSuite(["src/packages/pnpm-lock.yaml"]), true);
  assert.equal(requiresFullSuite(["docs/operations.md"]), false);
});

test("groups affected tests into controlled lanes", () => {
  const plan = createPlan({
    workspaces,
    changedFiles: ["src/packages/util/async-utils.ts"],
    affectedPackages: ["util", "server", "frontend", "chat"],
    base: "base",
  });
  assert.equal(plan.mode, "affected");
  assert.deepEqual(plan.lanes, [
    { lane: "server-1", packages: "server", shard: "1/2" },
    { lane: "server-2", packages: "server", shard: "2/2" },
    { lane: "frontend", packages: "frontend" },
    { lane: "rest", packages: "chat,util" },
  ]);
  assert.deepEqual(plan.depcheckPackages, ["util"]);
});

test("full plans retain every test-bearing workspace", () => {
  const plan = createPlan({ workspaces, full: true });
  assert.equal(plan.mode, "full");
  assert.equal(plan.hasTests, true);
  assert.ok(plan.selectedPackages.includes("notebook"));
  assert.ok(plan.selectedPackages.includes("project-host"));
  assert.ok(plan.depcheckPackages.includes("tasks"));
  assert.equal(
    new Set(plan.lanes.map(({ lane }) => lane)).size,
    plan.lanes.length,
  );
  assert.deepEqual(
    [
      ...new Set(plan.lanes.flatMap(({ packages }) => packages.split(","))),
    ].sort(),
    plan.selectedPackages,
  );
});

test("does not schedule server shards for unrelated affected packages", () => {
  const plan = createPlan({ workspaces, affectedPackages: ["frontend"] });
  assert.deepEqual(plan.lanes, [{ lane: "frontend", packages: "frontend" }]);
});
