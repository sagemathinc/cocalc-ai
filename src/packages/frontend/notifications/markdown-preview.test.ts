import {
  parseCollaborationReference,
  serializeCollaborationReference,
} from "@cocalc/util/collaboration-references";
import { serializeAgentMention } from "@cocalc/util/agent-mentions";
import { serializeArtifactMention } from "@cocalc/util/artifact-mentions";
import {
  notificationPreview,
  readableNotificationMarkdown,
} from "./markdown-preview";

const project_id = "11111111-1111-4111-8111-111111111111";
const link = (
  kind: "conversation" | "agent" | "artifact",
  title = "Picture Lake",
) =>
  serializeCollaborationReference({
    version: 1,
    target: { project_id, kind, resource_id: "a".repeat(64) },
    display_fallback: title,
  });

test.each(["conversation", "agent", "artifact"] as const)(
  "keeps complete %s links even when the encoded atom exceeds 240 characters",
  (kind) => {
    const markup = link(kind);
    expect(markup.length).toBeGreaterThan(240);
    expect(notificationPreview(markup)).toBe(markup);
    expect(
      parseCollaborationReference(notificationPreview(markup)),
    ).toBeDefined();
    expect(readableNotificationMarkdown(markup)).toBe(markup);
  },
);

test("counts multiple links by their labels and never partially includes an atom", () => {
  const a = link("artifact", "One");
  const b = link("conversation", "Two");
  expect(notificationPreview(`${a} and ${b} done`, 16)).toBe(
    `${a} and ${b} done`,
  );
  expect(notificationPreview(`${a} and ${b} done`, 9)).toBe(`${a} and ...`);
  expect(notificationPreview(`${"x".repeat(241)} ${a}`)).toBe(
    `${"x".repeat(240)}...`,
  );
});

test("retains bound legacy agent and artifact mentions", () => {
  const agent = serializeAgentMention({
    version: 1,
    naming_account_id: project_id,
    target: { project_id, agent_id: project_id },
    name: "reviewer",
  });
  const artifact = serializeArtifactMention({
    version: 1,
    project_id,
    entry_id: "b".repeat(64),
    name: "picture",
  });
  expect(notificationPreview(`${agent} ${artifact}`)).toBe(
    `${agent} ${artifact}`,
  );
  for (const markup of [agent, artifact])
    expect(readableNotificationMarkdown(markup.slice(0, 240) + "...")).toBe(
      "Linked resource (open the conversation to view).",
    );
});

test("old truncated payloads get a readable fallback without guessing a link", () => {
  const old = `New reply:\n\n${link("artifact").slice(0, 240)}...`;
  expect(readableNotificationMarkdown(old)).toBe(
    "New reply:\n\nLinked resource (open the conversation to view).",
  );
  expect(
    readableNotificationMarkdown(
      "Plain text and [a link](https://example.com)",
    ),
  ).toBe("Plain text and [a link](https://example.com)");
});

test("bounds reference-heavy previews and does not split Unicode characters", () => {
  const markup = link("artifact", "x");
  const preview = notificationPreview(markup.repeat(500));
  expect(preview.length).toBeLessThan(17000);
  expect(preview.endsWith("</a>...")).toBe(true);
  expect(notificationPreview("\u{1f600}".repeat(241))).toBe(
    "\u{1f600}".repeat(240) + "...",
  );
});
