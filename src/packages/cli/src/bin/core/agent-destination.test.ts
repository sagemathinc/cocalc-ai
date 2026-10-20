import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AgentNetworkDiscovery } from "@cocalc/conat/agents/personal";
import { externalAgentHandle } from "@cocalc/conat/agents/external";
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

function withExternal(label: string, value = directory()) {
  const agent_id = randomUUID();
  const external = {
    kind: "external" as const,
    account_id: randomUUID(),
    agent_id,
    installation_id: randomUUID(),
  };
  value.peers.push({
    member: {
      kind: "external",
      member_id: agent_id,
      source: external,
      label,
      available: true,
      added_at: new Date().toISOString(),
    },
    networks: value.peers[0].networks,
  });
  return { value, external, member_id: agent_id };
}

test("an external agent's handle is its label's leading name", () => {
  assert.equal(
    externalAgentHandle("ops0 on alpha.cocalc.ai (ops project)"),
    "ops0",
  );
  assert.equal(externalAgentHandle("Release_Bot (laptop)"), "release-bot");
  assert.equal(externalAgentHandle("ops0"), "ops0");
  assert.equal(externalAgentHandle("(unnamed)"), undefined);
  assert.equal(externalAgentHandle("9lives"), undefined);
  assert.equal(externalAgentHandle(""), undefined);
});

test("send reaches an external agent by handle, member id or full label", () => {
  const label = "ops0 on alpha.cocalc.ai (ops project)";
  const { value, external, member_id } = withExternal(label);
  const expected = {
    target: external,
    agent_network_id: network,
    agent_network_title: "Review",
    delivery_mode: "queued",
  };
  for (const name of ["ops0", "@ops0", member_id, label, label.toUpperCase()])
    assert.deepEqual(resolveAgentName(name, value), expected, name);
  // Registered agents are unchanged, also by their id.
  assert.equal(resolveAgentName("reviewer", value).target, target);
  assert.equal(resolveAgentName(target.agent_id, value).target, target);
  // Other text with spaces is still not a name.
  assert.throws(() => resolveAgentName("ops0 on beta", value), /lowercase/);
  assert.throws(() => resolveAgentName(randomUUID(), value), /No approved/);
});

test("two external agents with one handle are ambiguous, not a guess", () => {
  const { value } = withExternal("ops0 on alpha.cocalc.ai (ops project)");
  withExternal("ops0 on beta (laptop)", value);
  assert.throws(() => resolveAgentName("ops0", value), /Ambiguous/);
  assert.throws(
    () => resolveBroadcastTargets(["ops0"], value),
    /ambiguous peer/,
  );
});

test("an external label that is also a registered name is ambiguous", () => {
  // The full-label match must not hide the registered agent of that name.
  const { value } = withExternal("reviewer");
  assert.throws(() => resolveAgentName("reviewer", value), /Ambiguous/);
  // A mention the person selected still names the registered one.
  assert.equal(
    resolveAgentName("reviewer", value, [{ name: "reviewer", target }]).target,
    target,
  );
});

test("broadcast reaches an external agent by handle", () => {
  const { value, external } = withExternal(
    "ops0 on alpha.cocalc.ai (ops project)",
  );
  assert.deepEqual(resolveBroadcastTargets(["@ops0"], value).targets, [
    external,
  ]);
});
