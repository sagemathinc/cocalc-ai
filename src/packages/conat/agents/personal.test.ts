import { randomUUID } from "node:crypto";
import {
  validateAgentRpcBroadcastOutcome,
  validateAgentRpcRequest,
} from "./rpc";
import { normalizeAgentName } from "./personal";

const endpoint = () => ({ project_id: randomUUID(), agent_id: randomUUID() });
const member = () => ({ kind: "registered" as const, endpoint: endpoint() });

test("session proposals are typed, bounded, and cannot claim a principal", () => {
  const source = member();
  const value = {
    version: 3 as const,
    action: "propose-session" as const,
    proposal_id: randomUUID(),
    delivery_mode: "queued" as const,
    title: "Review",
    members: [source, member()],
    reason: "Coordinate the release review",
  };
  expect(() => validateAgentRpcRequest(value)).not.toThrow();
  for (const invalid of [
    { ...value, proposal_id: "bad" },
    { ...value, members: [source] },
    { ...value, members: Array.from({ length: 65 }, member) },
    { ...value, delivery_mode: "interrupt" },
    { ...value, account_id: randomUUID() },
    { ...value, source: endpoint() },
  ])
    expect(() => validateAgentRpcRequest(invalid as any)).toThrow();
});

test("broadcasts bind the exact session, targets, body, and child outcomes", () => {
  const request = {
    version: 3 as const,
    action: "broadcast" as const,
    broadcast_id: randomUUID(),
    agent_session_id: randomUUID(),
    targets: [endpoint(), endpoint()],
    body: "Review the release",
  };
  expect(() => validateAgentRpcRequest(request)).not.toThrow();
  const outcome = {
    version: 3 as const,
    broadcast_id: request.broadcast_id,
    agent_session_id: request.agent_session_id,
    outcome: "accepted" as const,
    observed_at: Date.now(),
    children: request.targets.map((target) => ({
      version: 3 as const,
      attempt_id: randomUUID(),
      agent_session_id: request.agent_session_id,
      target,
      outcome: "accepted" as const,
      observed_at: Date.now(),
    })),
  };
  expect(() =>
    validateAgentRpcBroadcastOutcome(outcome, request),
  ).not.toThrow();
  expect(() =>
    validateAgentRpcBroadcastOutcome(
      { ...outcome, broadcast_id: randomUUID() },
      request,
    ),
  ).toThrow();
  expect(() =>
    validateAgentRpcRequest({
      ...request,
      targets: [request.targets[0], request.targets[0]],
    }),
  ).toThrow();
});

test("personal names have no case-sensitive or project-local variants", () => {
  expect(normalizeAgentName(" Reviewer-2 ")).toBe("reviewer-2");
  expect(normalizeAgentName("a")).toBe("a");
  for (const name of [
    "all",
    "EVERYONE",
    "agents",
    "me",
    "-a",
    "a-",
    "a_b",
    "1a",
    "",
    "a".repeat(33),
    "r\u00e9viewer",
  ])
    expect(() => normalizeAgentName(name)).toThrow();
});
