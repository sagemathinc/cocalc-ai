import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { resolveAgentName } from "./agent-destination";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";

const a = { project_id: randomUUID(), agent_id: randomUUID() };
const b = { project_id: randomUUID(), agent_id: randomUUID() };
const destination = (target: AgentEndpoint = a, name = "reviewer") => ({
  link_id: randomUUID(),
  source: b,
  target,
  target_name: name,
  approved_by: randomUUID(),
  reason: "test",
  expires_at: "2099-01-01",
  allow_guidance: false,
});

test("named send matches exactly and permits optional at-sign", () => {
  assert.deepEqual(resolveAgentName("@reviewer", [destination()]), a);
  assert.throws(
    () => resolveAgentName("review", [destination()]),
    /No approved/,
  );
  assert.throws(
    () => resolveAgentName("Reviewer", [destination()]),
    /lowercase/,
  );
});

test("turn-bound mention wins over a later directory mapping", () => {
  assert.deepEqual(
    resolveAgentName(
      "reviewer",
      [destination(b)],
      [{ name: "reviewer", target: a }],
    ),
    a,
  );
  assert.deepEqual(
    resolveAgentName("reviewer", [], [{ name: "reviewer", target: a }]),
    a,
  );
});

test("conflicting bindings fail, duplicate links to the same endpoint do not", () => {
  assert.throws(
    () => resolveAgentName("reviewer", [destination(a), destination(b)]),
    /Ambiguous/,
  );
  assert.throws(
    () =>
      resolveAgentName(
        "reviewer",
        [],
        [
          { name: "reviewer", target: a },
          { name: "reviewer", target: b },
        ],
      ),
    /Ambiguous/,
  );
  assert.deepEqual(
    resolveAgentName("reviewer", [destination(), destination()]),
    a,
  );
});

test("invalid endpoint and unrelated names never select a fallback", () => {
  assert.throws(() =>
    resolveAgentName("reviewer", [destination({ ...a, agent_id: "invalid" })]),
  );
  assert.throws(
    () => resolveAgentName("reviewer", [destination(a, "other")]),
    /No approved/,
  );
});

test("retired textual name explains rename but already selected reference stays pinned", () => {
  const renamed = {
    ...destination(a, "auditor"),
    target_retired_names: ["reviewer"],
  };
  assert.throws(
    () => resolveAgentName("reviewer", [renamed]),
    /name_renamed.*auditor/,
  );
  assert.deepEqual(
    resolveAgentName("reviewer", [renamed], [{ name: "reviewer", target: a }]),
    a,
  );
});
