import { randomUUID } from "node:crypto";
import {
  agentMessagingSubject,
  agentInboxPrefix,
  allowsAgentSubject,
  parseAgentMessagingSubject,
  validateAgentMessage,
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
test("message validation bounds bytes and requires a single explicit target", () => {
  const request = {
    action: "send" as const,
    request_id: run,
    target_agent_id: target,
    body: "hello",
  };
  expect(() => validateAgentMessage(request)).not.toThrow();
  for (const patch of [
    { body: "" },
    { body: "a".repeat(32769) },
    { body: "\u00e9".repeat(16385) },
    { request_id: "bad" },
    { guidance: "true" },
    { target_agent_id: undefined },
    { target: { project_id: target, path: "a.chat", thread_id: run } },
  ]) {
    expect(() =>
      validateAgentMessage({ ...request, ...patch } as any),
    ).toThrow();
  }
});
