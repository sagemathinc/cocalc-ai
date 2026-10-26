import {
  agentMentionReference,
  agentMentionReferenceMap,
  agentMentionTargetKey,
  augmentPromptWithAgentMentions,
  extractAgentMentions,
  parseAgentMention,
  serializeAgentMention,
} from "./agent-mentions";
import type { AgentMentionReference } from "./agent-mentions";

const reference: AgentMentionReference = {
  version: 1,
  naming_account_id: "11111111-1111-4111-8111-111111111111",
  target: {
    project_id: "22222222-2222-4222-8222-222222222222",
    agent_id: "33333333-3333-4333-8333-333333333333",
  },
  name: "reviewer",
};

test("stable typed reference round trips without a person account-id", () => {
  const markup = serializeAgentMention(reference);
  expect(markup).not.toContain("account-id=");
  expect(parseAgentMention(markup)).toEqual(reference);
  expect(extractAgentMentions(`${markup} then ${markup}`)).toEqual([reference]);
});

test("raw names, forged labels, malformed payloads, and unknown versions are not bound references", () => {
  expect(
    extractAgentMentions("@reviewer [@reviewer](https://example.org)"),
  ).toEqual([]);
  expect(
    parseAgentMention(
      serializeAgentMention(reference).replace(">@reviewer", ">@other"),
    ),
  ).toBeUndefined();
  expect(
    parseAgentMention(
      '<span class="agent-mention" data-agent-reference="%zz">@reviewer</span>',
    ),
  ).toBeUndefined();
  expect(() =>
    serializeAgentMention({ ...reference, version: 2 } as any),
  ).toThrow();
  expect(() =>
    serializeAgentMention({ ...reference, name: "<script>" }),
  ).toThrow();
});

test("rename snapshots keep their exact target and naming principal", () => {
  const renamed = { ...reference, name: "critic" };
  expect(parseAgentMention(serializeAgentMention(reference))).toEqual(
    reference,
  );
  expect(parseAgentMention(serializeAgentMention(renamed))?.target).toEqual(
    reference.target,
  );
});

test("prompt reference map rejects ambiguous display names", () => {
  expect(agentMentionReferenceMap([reference])).toEqual({
    "@reviewer": reference,
  });
  expect(() =>
    agentMentionReferenceMap([
      reference,
      {
        ...reference,
        target: { ...reference.target, agent_id: reference.naming_account_id },
      },
    ]),
  ).toThrow("Ambiguous");
  expect(augmentPromptWithAgentMentions("Review this", [reference])).toContain(
    reference.target.agent_id,
  );
  expect(augmentPromptWithAgentMentions("@reviewer", [])).toBe("@reviewer");
});

const external: AgentMentionReference = {
  version: 1,
  naming_account_id: "11111111-1111-4111-8111-111111111111",
  target: {
    kind: "external",
    account_id: "66666666-6666-4666-8666-666666666666",
    agent_id: "77777777-7777-4777-8777-777777777777",
    installation_id: "88888888-8888-4888-8888-888888888888",
  },
  name: "ops0",
};

test("an agent on another site round trips as its own kind of target", () => {
  const markup = serializeAgentMention(external);
  expect(parseAgentMention(markup)).toEqual(external);
  expect(
    extractAgentMentions(`${markup} and ${serializeAgentMention(reference)}`),
  ).toEqual([external, reference]);
  // Not a registered agent's endpoint, and nothing else rides along.
  expect(
    agentMentionReference({
      ...external,
      target: {
        ...external.target,
        project_id: reference.target["project_id"],
      },
    }),
  ).toEqual(external);
  for (const target of [
    { ...external.target, installation_id: "not-a-uuid" },
    { kind: "remote", ...reference.target },
    { kind: "external", account_id: external.naming_account_id },
  ])
    expect(agentMentionReference({ ...external, target })).toBeUndefined();
});

test("the prompt tells the agent how an agent on another site is reached", () => {
  const prompt = augmentPromptWithAgentMentions("Ask @ops0", [external]);
  expect(prompt).toContain('"kind":"external"');
  expect(prompt).toContain("cocalc agent send");
  expect(
    augmentPromptWithAgentMentions("Ask @reviewer", [reference]),
  ).not.toContain("another site");
  // The same name for an agent here and one on another site is ambiguous.
  expect(() =>
    agentMentionReferenceMap([external, { ...reference, name: "ops0" }]),
  ).toThrow("Ambiguous");
  expect(
    agentMentionTargetKey({
      ...external.target,
      agent_id: external.target.agent_id.toUpperCase(),
    } as any),
  ).toBe(agentMentionTargetKey(external.target));
});
