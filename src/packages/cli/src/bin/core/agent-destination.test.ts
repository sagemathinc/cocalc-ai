import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AgentNetworkDiscovery } from "@cocalc/conat/agents/personal";
import { resolveAgentName } from "./agent-destination";

const source = { project_id: randomUUID(), agent_id: randomUUID() };
const target = { project_id: randomUUID(), agent_id: randomUUID() };
const network = randomUUID();

function directory(
  networks = [network],
  endpoint = target,
): AgentNetworkDiscovery {
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
        networks: networks.map((agent_network_id) => ({
          agent_network_id,
          title: "Review",
          delivery_mode: "queued",
          generation: randomUUID(),
        })),
      },
    ],
  };
}

test("name resolution returns the exact peer and authorizing network", () => {
  assert.deepEqual(resolveAgentName("@reviewer", directory()), {
    target,
    agent_network_id: network,
  });
  assert.throws(() => resolveAgentName("Reviewer", directory()), /lowercase/);
  assert.throws(() => resolveAgentName("auditor", directory()), /No approved/);
});

test("ambiguous networks require an explicit network id", () => {
  const other = randomUUID();
  assert.throws(
    () => resolveAgentName("reviewer", directory([network, other])),
    /Multiple Agent Networks/,
  );
  assert.deepEqual(
    resolveAgentName("reviewer", directory([network, other]), [], other),
    { target, agent_network_id: other },
  );
});

test("turn references pin identity but never create authority", () => {
  assert.deepEqual(
    resolveAgentName("reviewer", directory(), [{ name: "reviewer", target }]),
    { target, agent_network_id: network },
  );
  assert.throws(
    () =>
      resolveAgentName("reviewer", directory(), [
        { name: "reviewer", target: source },
      ]),
    /No approved/,
  );
});
