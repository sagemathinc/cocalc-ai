import { randomUUID } from "node:crypto";
import { validateAgentRpcRequest } from "./rpc";
import { normalizeAgentName } from "./personal";

const request = () => ({
  version: 2 as const,
  action: "request-connection" as const,
  request_id: randomUUID(),
  target: { project_id: randomUUID(), agent_id: randomUUID() },
  reason: "review",
  ttl_seconds: null,
  both_directions: true,
  allow_guidance: false,
});

test("approval request protocol is typed and cannot claim source or principal", () => {
  const value = request();
  expect(() => validateAgentRpcRequest(value)).not.toThrow();
  expect(() =>
    validateAgentRpcRequest({
      version: 2,
      action: "connection-request",
      request_id: value.request_id,
    }),
  ).not.toThrow();
  for (const extra of [
    { account_id: randomUUID() },
    { run_id: randomUUID() },
    { source: value.target },
    { ttl_seconds: 0 },
    { ttl_seconds: 31 * 86400 },
    { ttl_seconds: NaN },
    { both_directions: "false" },
    { allow_guidance: "true" },
    { request_id: "bad" },
    { reason: "" },
    { reason: "x".repeat(2001) },
    { bidirectional: true },
  ])
    expect(() =>
      validateAgentRpcRequest({ ...value, ...extra } as any),
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
