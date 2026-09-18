import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AgentSessionDiscovery } from "@cocalc/conat/agents/personal";
import { resolveAgentName } from "./agent-destination";

const source = { project_id: randomUUID(), agent_id: randomUUID() };
const target = { project_id: randomUUID(), agent_id: randomUUID() };
const session = randomUUID();

function directory(
  sessions = [session],
  endpoint = target,
): AgentSessionDiscovery {
  return {
    peers: [
      {
        member: {
          kind: "registered",
          member_id: endpoint.agent_id,
          endpoint,
          name: "reviewer",
          available: true,
          added_at: new Date().toISOString(),
        },
        sessions: sessions.map((agent_session_id) => ({
          agent_session_id,
          title: "Review",
          delivery_mode: "queued",
          generation: randomUUID(),
        })),
      },
    ],
  };
}

test("name resolution returns the exact peer and authorizing session", () => {
  assert.deepEqual(resolveAgentName("@reviewer", directory()), {
    target,
    agent_session_id: session,
  });
  assert.throws(() => resolveAgentName("Reviewer", directory()), /lowercase/);
  assert.throws(() => resolveAgentName("auditor", directory()), /No approved/);
});

test("ambiguous sessions require an explicit session id", () => {
  const other = randomUUID();
  assert.throws(
    () => resolveAgentName("reviewer", directory([session, other])),
    /Multiple Agent Sessions/,
  );
  assert.deepEqual(
    resolveAgentName("reviewer", directory([session, other]), [], other),
    { target, agent_session_id: other },
  );
});

test("turn references pin identity but never create authority", () => {
  assert.deepEqual(
    resolveAgentName("reviewer", directory(), [{ name: "reviewer", target }]),
    { target, agent_session_id: session },
  );
  assert.throws(
    () =>
      resolveAgentName("reviewer", directory(), [
        { name: "reviewer", target: source },
      ]),
    /No approved/,
  );
});
