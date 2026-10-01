import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPlan,
  directlyChangedPackages,
  discoverWorkspaces,
  requiresFullSuite,
} from "./ci-test-plan.mjs";

const workspaces = discoverWorkspaces();

test("PR merge parents preserve changed-file planning and deeper bases can be fetched", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-plan-shallow-"));
  try {
    const origin = join(dir, "origin");
    const shallow = join(dir, "shallow");
    const git = (cwd, ...args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    git(dir, "init", "--quiet", "--initial-branch=main", origin);
    git(origin, "config", "user.name", "CI Planner Test");
    git(origin, "config", "user.email", "ci-planner@example.invalid");
    const commitFile = (name) => {
      writeFileSync(join(origin, name), name);
      git(origin, "add", name);
      git(origin, "commit", "--quiet", "-m", name);
    };
    commitFile("initial");
    const initial = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "--quiet", "-b", "feature");
    commitFile("feature-change");
    git(origin, "checkout", "--quiet", "main");
    commitFile("base-change");
    const base = git(origin, "rev-parse", "HEAD");
    git(origin, "merge", "--quiet", "--no-ff", "feature", "-m", "PR merge");
    git(dir, "clone", "--quiet", "--no-local", "--depth=2", origin, shallow);

    git(shallow, "merge-base", "--is-ancestor", base, "HEAD");
    const changedFiles = (cwd, since) =>
      git(cwd, "diff", "--name-only", "--diff-filter=ACMR", `${since}...HEAD`);
    assert.equal(changedFiles(shallow, base), changedFiles(origin, base));
    assert.equal(changedFiles(shallow, base), "feature-change");

    assert.notEqual(
      spawnSync("git", ["merge-base", "--is-ancestor", initial, "HEAD"], {
        cwd: shallow,
        stdio: "pipe",
      }).status,
      0,
    );
    git(shallow, "fetch", "--no-tags", "--unshallow", "origin");
    git(shallow, "merge-base", "--is-ancestor", initial, "HEAD");
    assert.equal(changedFiles(shallow, initial), changedFiles(origin, initial));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    { lane: "server-1", packages: "server", shard: "1/3" },
    { lane: "server-2", packages: "server", shard: "2/3" },
    {
      lane: "server-3",
      packages: "server",
      shard: "3/3",
      cache_fallback_lane: "server-2",
    },
    {
      lane: "frontend-1",
      packages: "frontend",
      shard: "1/2",
      cache_fallback_lane: "frontend",
    },
    {
      lane: "frontend-2",
      packages: "frontend",
      shard: "2/2",
      cache_fallback_lane: "frontend",
    },
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
  const scheduled = plan.lanes.flatMap(({ packages }) => packages.split(","));
  for (const name of plan.selectedPackages) {
    assert.equal(
      scheduled.filter((packageName) => packageName === name).length,
      name === "server" ? 3 : name === "frontend" ? 2 : 1,
      name,
    );
  }
});

test("does not schedule server shards for unrelated affected packages", () => {
  const plan = createPlan({ workspaces, affectedPackages: ["frontend"] });
  assert.deepEqual(
    plan.lanes.map(({ packages, shard }) => ({ packages, shard })),
    [
      { packages: "frontend", shard: "1/2" },
      { packages: "frontend", shard: "2/2" },
    ],
  );
});

test("isolates Conat without expanding affected selection", () => {
  const plan = createPlan({
    workspaces,
    affectedPackages: ["conat", "cli"],
  });
  assert.deepEqual(plan.lanes, [
    { lane: "conat", packages: "conat", cache_fallback_lane: "rest" },
    { lane: "rest", packages: "cli" },
  ]);
});

test("shards cover each heavy package exactly once and retain warm cache fallbacks", () => {
  const plan = createPlan({ workspaces, full: true });
  for (const [name, count] of [
    ["server", 3],
    ["frontend", 2],
  ]) {
    const lanes = plan.lanes.filter(({ packages }) => packages === name);
    assert.deepEqual(
      lanes.map(({ shard }) => shard),
      Array.from({ length: count }, (_, index) => `${index + 1}/${count}`),
    );
  }
  assert.equal(plan.lanes.length, 8);
  assert.equal(
    plan.lanes.find(({ lane }) => lane === "server-3").cache_fallback_lane,
    "server-2",
  );
  assert.ok(
    plan.lanes
      .filter(({ packages }) => packages === "frontend")
      .every(({ cache_fallback_lane }) => cache_fallback_lane === "frontend"),
  );
});

test("balances database and backend without expanding affected selection", () => {
  for (const heavy of [["backend"], ["database"], ["backend", "database"]]) {
    const plan = createPlan({
      workspaces,
      affectedPackages: [...heavy, "cli"],
    });
    assert.deepEqual(plan.lanes, [
      { lane: "backend-database", packages: heavy.join(",") },
      { lane: "rest", packages: "cli" },
    ]);
  }
});
