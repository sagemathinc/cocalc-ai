/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The fuzzer's model and generator, without a cluster:
//   node --test src/scripts/multibay/fuzz/model.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateOp, makeRng, Model, VISIBLE_GROUPS } from "./model.mjs";

const ACCOUNTS = [
  { account_id: "a0", home_bay_id: "bay-0", name: "a0" },
  { account_id: "a1", home_bay_id: "bay-0", name: "a1" },
  { account_id: "b0", home_bay_id: "bay-1", name: "b0" },
  { account_id: "b1", home_bay_id: "bay-1", name: "b1" },
];

/** Run the generator against the model, applying every operation that is
 * expected (or, for "either", assumed) to succeed. */
function simulate(seed, steps) {
  const model = new Model();
  for (const a of ACCOUNTS) model.addAccount(a);
  const rng = makeRng(seed);
  const ops = [];
  for (let step = 0; step < steps; step++) {
    const op = generateOp(model, rng, step);
    ops.push(op);
    if (op.expect !== "fail") {
      model.apply(op, { project_id: `p${step}` });
    }
  }
  return { model, ops };
}

describe("fuzz model", () => {
  it("is deterministic for a seed", () => {
    assert.deepEqual(simulate(7, 200).ops, simulate(7, 200).ops);
    assert.notDeepEqual(simulate(7, 50).ops, simulate(8, 50).ops);
  });

  it("generates only well-formed operations", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const model = new Model();
      for (const a of ACCOUNTS) model.addAccount(a);
      const rng = makeRng(seed);
      for (let step = 0; step < 150; step++) {
        const op = generateOp(model, rng, step);
        assert.ok(model.accounts.has(op.actor), "actor exists");
        assert.ok(["ok", "fail", "either"].includes(op.expect));
        if (op.kind !== "create") {
          assert.ok(model.projects.has(op.project_id), "project exists");
        }
        const group = op.project_id
          ? model.group(op.project_id, op.actor)
          : null;
        if (op.target) {
          assert.notEqual(op.target, op.actor);
          assert.ok(model.accounts.has(op.target));
        }
        // The rules the oracle asserts (see the plan's table).
        if (group == null && op.kind !== "create") {
          assert.equal(op.expect, "fail", `non-member ${op.kind}`);
        }
        if (op.kind === "rename" && group === "viewer") {
          assert.equal(op.expect, "fail");
        }
        if (op.kind === "invite") {
          assert.equal(model.group(op.project_id, op.target), null);
        }
        if (["set-role", "remove", "transfer"].includes(op.kind)) {
          assert.ok(VISIBLE_GROUPS.has(model.group(op.project_id, op.target)));
          assert.notEqual(model.group(op.project_id, op.target), "owner");
        }
        if (op.kind === "transfer" && group === "owner") {
          const target = model.group(op.project_id, op.target);
          assert.equal(op.expect, target === "collaborator" ? "ok" : "fail");
        }
        if (op.expect !== "fail") model.apply(op, { project_id: `p${step}` });
      }
    }
  });

  it("keeps exactly one owner per project", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { model } = simulate(seed, 150);
      for (const project of model.projects.values()) {
        const owners = Object.values(project.users).filter(
          (g) => g === "owner",
        );
        assert.equal(owners.length, 1, `project ${project.project_id}`);
      }
    }
  });

  it("exercises every operation kind and refusals", () => {
    const { ops } = simulate(3, 300);
    for (const kind of [
      "create",
      "rename",
      "invite",
      "set-role",
      "remove",
      "transfer",
    ]) {
      assert.ok(
        ops.some((op) => op.kind === kind),
        kind,
      );
    }
    assert.ok(ops.some((op) => op.expect === "fail"));
  });

  it("derives each account's expected project list", () => {
    const model = new Model();
    for (const a of ACCOUNTS) model.addAccount(a);
    model.apply(
      { kind: "create", actor: "a0", title: "x" },
      { project_id: "p" },
    );
    model.apply({ kind: "invite", project_id: "p", target: "b0" });
    model.apply({
      kind: "set-role",
      project_id: "p",
      target: "b0",
      role: "viewer",
    });
    assert.deepEqual(
      [...model.expectedList("b0")],
      [["p", { title: "x", group: "viewer" }]],
    );
    model.apply({ kind: "remove", project_id: "p", target: "b0" });
    assert.equal(model.expectedList("b0").size, 0);
    assert.equal(model.projects.get("p").owning_bay_id, "bay-0");
  });
});
