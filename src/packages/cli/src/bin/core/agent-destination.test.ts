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
    agent_network_title: "Review",
  });
  assert.throws(() => resolveAgentName("Reviewer", directory()), /lowercase/);
  assert.throws(() => resolveAgentName("auditor", directory()), /No approved/);
});

test("overlapping networks prefer live delivery without caller disambiguation", () => {
  const other = randomUUID();
  const value = directory([network, other]);
  value.peers[0].networks[1].delivery_mode = "live";
  assert.deepEqual(resolveAgentName("reviewer", value), {
    target,
    agent_network_id: other,
    agent_network_title: "Review",
  });
  assert.deepEqual(resolveAgentName("reviewer", value, [], other), {
    target,
    agent_network_id: other,
    agent_network_title: "Review",
  });
});

test("network titles disambiguate without exposing an id", () => {
  const other = randomUUID();
  const value = directory([network, other]);
  value.peers[0].networks[1].title = "Support";
  assert.deepEqual(resolveAgentName("reviewer", value, [], "Support"), {
    target,
    agent_network_id: other,
    agent_network_title: "Support",
  });
});

test("turn references pin identity but never create authority", () => {
  assert.deepEqual(
    resolveAgentName("reviewer", directory(), [{ name: "reviewer", target }]),
    { target, agent_network_id: network, agent_network_title: "Review" },
  );
  assert.throws(
    () =>
      resolveAgentName("reviewer", directory(), [
        { name: "reviewer", target: source },
      ]),
    /No approved/,
  );
});
