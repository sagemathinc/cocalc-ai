import MarkdownIt from "markdown-it";
import { mentionPlugin } from "../markdown/mentions-plugin";
import { createAgentMention } from "../editors/slate/elements/agent-mention";
import { createArtifactMention } from "../editors/slate/elements/artifact-mention";
import { createComputerMention } from "../editors/slate/elements/computer-mention";
import {
  parseComputerMention,
  serializeComputerMention,
} from "@cocalc/util/computer-mentions";
import {
  parseArtifactMention,
  serializeArtifactMention,
} from "@cocalc/util/artifact-mentions";
import {
  getMarkdownToSlate,
  getSlateToMarkdown,
} from "../editors/slate/elements/register";
import {
  parseAgentMention,
  serializeAgentMention,
} from "@cocalc/util/agent-mentions";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";
import { bindAgentName, hasUnboundAgentName } from "./unbound-mentions";

const reference: AgentMentionReference = {
  version: 1,
  naming_account_id: "11111111-1111-4111-8111-111111111111",
  target: {
    project_id: "22222222-2222-4222-8222-222222222222",
    agent_id: "33333333-3333-4333-8333-333333333333",
  },
  name: "reviewer",
};
test("Markdown parses a distinct agent token and Slate round trips stable reference", () => {
  const md = new MarkdownIt({ html: true });
  md.use(mentionPlugin);
  const markup = serializeAgentMention(reference);
  const token = md.parse(markup, {})[1].children![0];
  expect(token.type).toBe("agent-mention");
  const node = getMarkdownToSlate("agent-mention")({ token });
  expect(node).toEqual(createAgentMention(reference));
  expect(node).not.toHaveProperty("account_id");
  expect(
    parseAgentMention(getSlateToMarkdown("agent-mention")({ node } as any)),
  ).toEqual(reference);
  expect(md.render(markup)).toContain(markup);
});
test("artifact mention round trips the catalog identity through Markdown and Slate", () => {
  const artifact = {
    version: 1 as const,
    project_id: "22222222-2222-4222-8222-222222222222",
    entry_id: "a".repeat(64),
    name: "nb1",
  };
  const md = new MarkdownIt({ html: true });
  md.use(mentionPlugin);
  const markup = serializeArtifactMention(artifact);
  const token = md.parse(markup, {})[1].children![0];
  expect(token.type).toBe("artifact-mention");
  const node = getMarkdownToSlate("artifact-mention")({ token });
  expect(node).toEqual(createArtifactMention(artifact));
  expect(
    parseArtifactMention(
      getSlateToMarkdown("artifact-mention")({ node } as any),
    ),
  ).toEqual(artifact);
});
test("raw resolution is explicit and leaves bound mentions and email addresses alone", () => {
  const bound = serializeAgentMention(reference);
  const text = `person@reviewer.com ${bound} ask @reviewer`;
  expect(hasUnboundAgentName(text, "reviewer")).toBe(true);
  expect(bindAgentName(text, reference)).toBe(
    `person@reviewer.com ${bound} ask ${bound}`,
  );
  expect(hasUnboundAgentName(bound, "reviewer")).toBe(false);
  expect(hasUnboundAgentName("@reviewer-other", "reviewer")).toBe(false);
});

test.each([
  "`ask @reviewer`",
  "`` ask `@reviewer` ``",
  "```text\nask @reviewer\n```",
  "~~~\n@reviewer\n~~~",
  "```\n@reviewer",
  '<a title="ask @reviewer">link</a>',
  '<span class="user-mention" account-id="person">@reviewer</span>',
  "[ask @reviewer](https://example.test)",
  "[link](https://example.test/@reviewer)",
  "[link][ask @reviewer]",
  "<https://example.test/@reviewer>",
  "<!-- ask @reviewer -->",
  "person@reviewer.com",
])("raw resolution preserves literal or linked content: %s", (text) => {
  expect(hasUnboundAgentName(text, "reviewer")).toBe(false);
  expect(bindAgentName(`ask @reviewer\n${text}`, reference)).toBe(
    `ask ${serializeAgentMention(reference)}\n${text}`,
  );
});

test("computer mention round trips its identity through Markdown and Slate", () => {
  const computer = {
    version: 1 as const,
    computer_id: "1a057860-889d-461a-9073-4b8c69d65123",
    name: "m1",
  };
  const md = new MarkdownIt({ html: true });
  md.use(mentionPlugin);
  const markup = serializeComputerMention(computer);
  const token = md
    .parse(`disk usage on ${markup}?`, {})[1]
    .children!.find((t) => t.type === "computer-mention")!;
  expect(token).toBeTruthy();
  const node = getMarkdownToSlate("computer-mention")({ token });
  expect(node).toEqual(createComputerMention(computer));
  expect(
    parseComputerMention(
      getSlateToMarkdown("computer-mention")({ node } as any),
    ),
  ).toEqual(computer);
  expect(md.render(markup)).toContain(markup);
});
