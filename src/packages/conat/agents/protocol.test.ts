import { randomUUID } from "node:crypto";
import {
  agentMessagingSubject,
  agentInboxPrefix,
  allowsAgentSubject,
  parseAgentMessagingSubject,
  validateAgentInspection,
} from "./protocol";

const agent = randomUUID(),
  run = randomUUID(),
  target = randomUUID();
test("identity may publish only its exact sealed subject and subscribe only to its isolated inbox", () => {
  expect(
    allowsAgentSubject(agent, run, agentMessagingSubject(agent, run), "pub"),
  ).toBe(true);
  expect(
    allowsAgentSubject(
      agent,
      run,
      `${agentInboxPrefix(agent, run)}.reply`,
      "sub",
    ),
  ).toBe(true);
  for (const subject of [
    agentMessagingSubject(target, run),
    agentMessagingSubject(agent, target),
    `project.${target}.api`,
    `hub.account.${agent}.api`,
    "public.>",
    `${agentInboxPrefix(target, run)}.reply`,
    `${agentInboxPrefix(agent, run)}other.reply`,
    "_INBOX.>",
    "agent-messaging.>",
  ]) {
    expect(allowsAgentSubject(agent, run, subject, "pub")).toBe(false);
    expect(allowsAgentSubject(agent, run, subject, "sub")).toBe(false);
  }
  expect(
    allowsAgentSubject(agent, run, agentMessagingSubject(agent, run), "sub"),
  ).toBe(false);
  expect(
    allowsAgentSubject(
      agent,
      run,
      `${agentInboxPrefix(agent, run)}.reply`,
      "pub",
    ),
  ).toBe(false);
});

test("inspection exposes only the caller's sealed identity", () => {
  expect(() => validateAgentInspection({ action: "whoami" })).not.toThrow();
  for (const request of [
    { action: "whoami", agent_id: target },
    { action: "destinations", limit: 100 },
    { action: "messages", cursor: agent },
    { action: "messages", limit: 0 },
    { action: "messages", limit: 101 },
    { action: "messages", cursor: "bad" },
    { action: "destinations", target_agent_id: target },
    { action: "whoami", limit: 1 },
  ])
    expect(() => validateAgentInspection(request as any)).toThrow();
});
test("sealed subjects reject extra segments and wildcards", () => {
  expect(parseAgentMessagingSubject(agentMessagingSubject(agent, run))).toEqual(
    { agent_id: agent, run_id: run },
  );
  for (const subject of [
    "agent-messaging.*.*",
    `agent-messaging.${agent}.${run}.extra`,
  ])
    expect(() => parseAgentMessagingSubject(subject)).toThrow();
});
