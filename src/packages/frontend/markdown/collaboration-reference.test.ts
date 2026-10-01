import MarkdownIt from "markdown-it";
import { collaborationReferencePlugin, mentionPlugin } from "./mentions-plugin";
import { createCollaborationReference } from "../editors/slate/elements/collaboration-reference";
import {
  getMarkdownToSlate,
  getSlateToMarkdown,
} from "../editors/slate/elements/register";
import { serializeCollaborationReference } from "@cocalc/util/collaboration-references";
import type { CollaborationReference } from "@cocalc/util/collaboration-references";
import { collaborationReferenceHref } from "@cocalc/util/collaboration-references";
import { markdown_it } from "./index";
import { parse_markdown } from "../editors/slate/markdown-to-slate/parse-markdown";
import {
  collaboratorsTargetPath,
  parseCollaboratorsRoute,
} from "../collaborators/routing";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => undefined,
}));
jest.mock("@cocalc/frontend/collaborators/reference-picker-api", () => ({}));
jest.mock("@cocalc/frontend/project/access", () => ({
  ProjectAccessDialog: () => null,
}));

test.each(["agent", "artifact", "conversation"] as const)(
  "Markdown and Slate preserve unnamed %s targets and authored labels",
  (kind) => {
    const reference: CollaborationReference = {
      version: 1,
      target: {
        project_id: "11111111-1111-4111-8111-111111111111",
        resource_id: 'artifact:["thread/id","id%2F?query#fragment"]',
        kind,
      },
      display_fallback: "Shared work & **not emphasis**",
    };
    const md = new MarkdownIt({ html: true })
      .use(mentionPlugin)
      .use(collaborationReferencePlugin);
    const markup = serializeCollaborationReference(reference);
    const token = md.parse(markup, {})[1].children![0];
    expect(token.type).toBe("collaboration-reference");
    const node = getMarkdownToSlate(token.type)({ token });
    expect(node).toEqual(createCollaborationReference(reference));
    expect(getSlateToMarkdown(node?.type)({ node } as any)).toBe(markup);
    expect(md.render(markup)).toContain('href="/people/');
    expect(markdown_it.parse(markup, {})[1].children![0].type).toBe(
      "collaboration-reference",
    );
    expect(parse_markdown(markup).tokens[1].children![0].type).toBe(
      "collaboration-reference",
    );
    const route = {
      view: "conversations" as const,
      projectId: reference.target.project_id,
      resourceKind: kind,
      resourceId: reference.target.resource_id,
    };
    const href = collaborationReferenceHref(reference);
    expect(href).toBe(`/${collaboratorsTargetPath(route)}`);
    expect(
      parseCollaboratorsRoute(href.slice("/people/".length).split("/")),
    ).toEqual(route);
    const legacy = markup.replace(' href="/people/', ' href="/collaborators/');
    const legacyToken = parse_markdown(legacy).tokens[1].children![0];
    expect(legacyToken.type).toBe("collaboration-reference");
    const legacyNode = getMarkdownToSlate(legacyToken.type)({
      token: legacyToken,
    });
    expect(legacyNode).toEqual(node);
    expect(
      getSlateToMarkdown(legacyNode?.type)({ node: legacyNode } as any),
    ).toBe(markup);
  },
);
