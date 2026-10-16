/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { agentNetworkSelfContext } from "./agent-network-self";

const network = (title: string, delivery_mode: "live" | "queued" = "live") => ({
  agent_network_id: "00000000-0000-4000-8000-000000000001",
  title,
  delivery_mode,
  generation: "1",
});

test("names the agent as its peers see it", () => {
  // 2026-10-15: an agent whose appearance read "ops 1" signed as "ops2".
  expect(
    agentNetworkSelfContext({
      name: "ops1",
      networks: [network("cocalc-dev")],
    }),
  ).toBe(
    'Agent identity: in Agent Network "cocalc-dev" (live delivery), you are @ops1. Peers see your messages as from @ops1; refer to and sign as yourself with that name.',
  );
});

test("nothing without a name or a network", () => {
  expect(agentNetworkSelfContext(undefined)).toBeUndefined();
  expect(
    agentNetworkSelfContext({ networks: [network("cocalc-dev")] }),
  ).toBeUndefined();
  expect(
    agentNetworkSelfContext({ name: "ops1", networks: [] }),
  ).toBeUndefined();
});

test("network titles are quoted and bounded", () => {
  const context = agentNetworkSelfContext({
    name: "ops1",
    networks: [
      network('a "quoted"\ntitle'),
      ...Array.from({ length: 6 }, (_, i) => network(`n${i}`, "queued")),
    ],
  })!;
  expect(context).toContain('"a \\"quoted\\"\\ntitle" (live delivery)');
  expect(context).not.toContain("\n");
  expect(context).toContain("and 2 more");
});
