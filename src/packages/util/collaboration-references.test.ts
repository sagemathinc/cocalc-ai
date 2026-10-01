import MarkdownIt from "markdown-it";
import {
  collaborationReference,
  collaborationReferenceFromResource,
  collaborationReferenceHref,
  collaborationReferencePlugin,
  decodeCollaborationReference,
  encodeCollaborationReference,
  parseCollaborationReference,
  serializeCollaborationReference,
} from "./collaboration-references";
import type { CollaborationReference } from "./collaboration-references";
import type { CollaborationResource } from "./collaborators";
import { collaborationTargetKey } from "./collaborators";
import { extractAgentMentions, serializeAgentMention } from "./agent-mentions";
import {
  extractArtifactMentions,
  serializeArtifactMention,
} from "./artifact-mentions";
import { mentionPlugin } from "./markdown/mentions-plugin";

const project_id = "11111111-1111-4111-8111-111111111111";
const reference: CollaborationReference = {
  version: 1,
  target: { project_id, kind: "conversation", resource_id: "thread:123" },
  display_fallback:
    "Discussion about **x** & <y> \"quotes\" 'apostrophes' :smile: $x$",
};

test.each(["agent", "artifact", "conversation"] as const)(
  "named and unnamed %s references round trip",
  (kind) => {
    for (const alias of [
      undefined,
      "same-name",
      "Planning & \u00e9quipe",
      "A".repeat(128),
    ]) {
      const input = {
        ...reference,
        target: { ...reference.target, kind },
        ...(alias ? { alias } : {}),
      };
      const markup = serializeCollaborationReference(input);
      expect(parseCollaborationReference(markup)).toEqual(input);
      expect(
        decodeCollaborationReference(encodeCollaborationReference(input)),
      ).toEqual(input);
      expect(markup).toContain(collaborationReferenceHref(input));
      expect(markup).toContain('href="/people/conversations/');
      expect(markup).not.toContain("<y>");
      expect(extractAgentMentions(markup)).toEqual([]);
      expect(extractArtifactMentions(markup)).toEqual([]);
    }
  },
);

test("overlapping aliases and mutable labels never determine identity", () => {
  const keys = ["agent", "artifact", "conversation"].map((kind) => {
    const bound = collaborationReference({
      ...reference,
      alias: "shared",
      target: { ...reference.target, kind },
    })!;
    const changedLabel = {
      ...bound,
      alias: "renamed",
      display_fallback: "Renamed shared title",
    };
    expect(
      parseCollaborationReference(serializeCollaborationReference(changedLabel))
        ?.target,
    ).toEqual(bound.target);
    return collaborationTargetKey(bound.target);
  });
  expect(new Set(keys).size).toBe(3);
});

test("uses the collaboration alias bounds independently of legacy name syntax", () => {
  const bound = { ...reference, alias: "Planning " + "_".repeat(119) };
  expect(
    parseCollaborationReference(serializeCollaborationReference(bound)),
  ).toEqual(bound);
  expect(
    collaborationReference({ ...bound, alias: bound.alias + "x" }),
  ).toBeUndefined();
});

test("accepts the full directory resource identity bound without truncating identity", () => {
  const target = {
    ...reference.target,
    resource_id: "agent-thread:" + "x".repeat(243),
  };
  const bound = collaborationReferenceFromResource({
    ...target,
    title: "Legacy agent",
    personal: { alias: "Planning & \u00e9quipe" },
  } as CollaborationResource);
  expect(
    parseCollaborationReference(serializeCollaborationReference(bound)),
  ).toEqual({
    version: 1,
    target,
    display_fallback: "Legacy agent",
    alias: "Planning & \u00e9quipe",
  });
});

test("blank and multiline personal display aliases do not break reference insertion", () => {
  for (const alias of ["", "   ", "Planning\nnotes"]) {
    const bound = collaborationReferenceFromResource({
      ...reference.target,
      title: "Title",
      personal: { alias },
    } as CollaborationResource);
    expect(bound.alias).toBe(
      alias.includes("Planning") ? "Planning notes" : undefined,
    );
    expect(
      parseCollaborationReference(serializeCollaborationReference(bound)),
    ).toEqual(bound);
  }
});

test("source locators and personal metadata are stripped and labels bounded", () => {
  const resource = {
    ...reference.target,
    title: "A".repeat(255) + "\u{1f600} rest",
    chat_path: "/secret.chat",
    thread_id: "private-locator",
    personal: { alias: "shared" },
  } as CollaborationResource;
  const bound = collaborationReferenceFromResource(resource);
  expect(bound.display_fallback).toBe("A".repeat(255));
  expect(bound.target).toEqual(reference.target);
  expect(JSON.stringify(bound)).not.toContain("secret.chat");
  expect(
    parseCollaborationReference(serializeCollaborationReference(bound)),
  ).toEqual(bound);
});

test.each([
  null,
  {},
  { ...reference, version: 2 },
  { ...reference, display_fallback: "" },
  { ...reference, display_fallback: "a".repeat(257) },
  { ...reference, display_fallback: "bad\nlabel" },
  { ...reference, display_fallback: "bad\ud800" },
  { ...reference, alias: "" },
  { ...reference, alias: "bad\nlabel" },
  { ...reference, target: { ...reference.target, kind: "person" } },
  { ...reference, target: { ...reference.target, project_id: "invalid" } },
  {
    ...reference,
    target: { ...reference.target, resource_id: "x".repeat(257) },
  },
])("rejects invalid wire references %#", (value) => {
  expect(collaborationReference(value)).toBeUndefined();
});

test.each(["people", "collaborators"])(
  "rejects malformed, oversized, relabeled or redirected %s markup",
  (prefix) => {
    const markup = serializeCollaborationReference(reference).replace(
      ' href="/people/',
      ` href="/${prefix}/`,
    );
    expect(decodeCollaborationReference("%zz")).toBeUndefined();
    expect(decodeCollaborationReference("x".repeat(8193))).toBeUndefined();
    expect(
      parseCollaborationReference(
        markup.replace(
          `href="/${prefix}`,
          `href="https://example.test/${prefix}`,
        ),
      ),
    ).toBeUndefined();
    expect(
      parseCollaborationReference(
        markup.replace(">Discussion", ">Forged discussion"),
      ),
    ).toBeUndefined();
    expect(
      parseCollaborationReference(
        markup.replace("/thread%3A123", "/another-thread"),
      ),
    ).toBeUndefined();
  },
);

function parser() {
  return new MarkdownIt({ html: true })
    .use(mentionPlugin)
    .use(collaborationReferencePlugin);
}

test.each(["agent", "artifact", "conversation"] as const)(
  "saved %s references using the old workspace route still parse and render",
  (kind) => {
    const input = { ...reference, target: { ...reference.target, kind } };
    const canonical = serializeCollaborationReference(input);
    const legacy = canonical.replace(
      ' href="/people/',
      ' href="/collaborators/',
    );
    expect(legacy).not.toBe(canonical);
    expect(parseCollaborationReference(legacy)).toEqual(input);
    expect(parser().render(legacy)).toContain(canonical);
    expect(parser().render(legacy)).not.toContain('href="/collaborators/');
  },
);

test("Markdown consumes titles atomically and exports durable readable HTML", () => {
  const markup = serializeCollaborationReference(reference);
  const md = parser();
  const tokens = md.parse(markup, {})[1].children!;
  expect(tokens).toHaveLength(1);
  expect(tokens[0].type).toBe("collaboration-reference");
  expect(tokens[0]["reference"]).toEqual(reference);
  expect(md.render(markup)).toContain(markup);
});

test.each([
  "@shared",
  '"@shared"',
  "> @shared",
  "person@shared.example",
  "`@shared`",
  "```\n@shared\n```",
  "`BOUND`",
  "```html\nBOUND\n```",
  "<!-- BOUND -->",
])("does not bind literal text or code: %s", (text) => {
  const md = parser();
  const tokens = md.parse(
    text.replace("BOUND", serializeCollaborationReference(reference)),
    {},
  );
  expect(
    tokens
      .flatMap((token) => token.children ?? [])
      .some((token) => token.type === "collaboration-reference"),
  ).toBe(false);
});

test("legacy named agent and artifact wire forms retain their token and invocation semantics", () => {
  const md = parser();
  const agent = {
    version: 1 as const,
    naming_account_id: project_id,
    target: { project_id, agent_id: project_id },
    name: "same",
  };
  const artifact = {
    version: 1 as const,
    project_id,
    entry_id: "a".repeat(64),
    name: "same",
  };
  const markup = `${serializeAgentMention(agent)} ${serializeArtifactMention(artifact)}`;
  expect(md.parse(markup, {})[1].children!.map((token) => token.type)).toEqual([
    "agent-mention",
    "text",
    "artifact-mention",
  ]);
  expect(extractAgentMentions(markup)).toEqual([agent]);
  expect(extractArtifactMentions(markup)).toEqual([artifact]);
});
