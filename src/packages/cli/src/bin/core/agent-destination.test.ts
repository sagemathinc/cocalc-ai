import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AgentNetworkDiscovery } from "@cocalc/conat/agents/personal";
import { resolveAgentName, resolveBroadcastTargets } from "./agent-destination";

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
    delivery_mode: "queued",
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
    delivery_mode: "live",
  });
  assert.deepEqual(resolveAgentName("reviewer", value, [], other), {
    target,
    agent_network_id: other,
    agent_network_title: "Review",
    delivery_mode: "live",
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
    delivery_mode: "queued",
  });
});

test("turn references pin identity but never create authority", () => {
  assert.deepEqual(
    resolveAgentName("reviewer", directory(), [{ name: "reviewer", target }]),
    {
      target,
      agent_network_id: network,
      agent_network_title: "Review",
      delivery_mode: "queued",
    },
  );
  assert.throws(
    () =>
      resolveAgentName("reviewer", directory(), [
        { name: "reviewer", target: source },
      ]),
    /No approved/,
  );
});

test("broadcast targets accept names and every shape discovery prints", () => {
  const value = directory();
  const member = value.peers[0].member as any;
  const expected = {
    targets: [target],
    names: ["reviewer"],
    agent_network_id: network,
    agent_network_title: "Review",
  };
  for (const entry of [
    "reviewer",
    "@reviewer",
    target,
    { endpoint: target },
    member,
    value.peers[0],
    { kind: "registered", ...target },
    { member_id: member.member_id },
  ])
    assert.deepEqual(resolveBroadcastTargets([entry], value), expected);
  assert.deepEqual(
    resolveBroadcastTargets(["reviewer"], value, "Review"),
    expected,
  );
});

test("broadcast target errors name the entry and the field", () => {
  assert.throws(
    () =>
      resolveBroadcastTargets(
        [{ project_id: "x", agent_id: "y" }],
        directory(),
      ),
    /--targets\[0\]: .*project_id/,
  );
  assert.throws(
    () => resolveBroadcastTargets(["reviewer", 7], directory()),
    /--targets\[1\]: expected a peer name/,
  );
  assert.throws(
    () => resolveBroadcastTargets(["auditor"], directory()),
    /--targets\[0\]: no network peer named @auditor/,
  );
  assert.throws(() => resolveBroadcastTargets([], directory()), /non-empty/);
});

test("broadcast picks the one network all targets share", () => {
  const other = randomUUID();
  const second = { project_id: randomUUID(), agent_id: randomUUID() };
  const value = directory([network, other]);
  value.peers.push({
    ...directory([other], second).peers[0],
    member: {
      ...(directory([other], second).peers[0].member as any),
      name: "tester",
    },
  });
  const resolved = resolveBroadcastTargets(["reviewer", "tester"], value);
  assert.equal(resolved.agent_network_id, other);
  assert.deepEqual(resolved.targets, [target, second]);
  assert.throws(
    () => resolveBroadcastTargets(["reviewer", "tester"], value, "Nope"),
    /matches --agent-network "Nope"/,
  );
  const apart = directory([network]);
  apart.peers.push({
    ...directory([other], second).peers[0],
    member: {
      ...(directory([other], second).peers[0].member as any),
      name: "tester",
    },
  });
  assert.throws(
    () => resolveBroadcastTargets(["reviewer", "tester"], apart),
    /No single Agent Network includes all/,
  );
});

test("explicit targets in an explicit network need no discovery", () => {
  assert.deepEqual(resolveBroadcastTargets([target], undefined, network), {
    targets: [target],
    names: [undefined],
    agent_network_id: network,
  });
  assert.throws(
    () => resolveBroadcastTargets(["reviewer"], undefined, network),
    /discovery is required/,
  );
});
