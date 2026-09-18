import {
  agentMentionReferenceMap,
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
