/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The Markdown policies must say exactly what the pages say. Each policy's
// Markdown, rendered back to HTML, has the page's headings and the page's
// text. The hub serves the copy in @cocalc/util; this test also checks that
// copy is current. After changing a policy, regenerate it with
//
//   UPDATE_POLICY_MARKDOWN=1 pnpm exec jest public/policies/markdown.test.tsx

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { render } from "@testing-library/react";
import MarkdownIt from "markdown-it";

import { policyMarkdown } from "./markdown";
import { PolicyDocument, preparePolicyContent } from "./policy";
import { BUILTIN_POLICIES } from "./registry";

const GENERATED = join(
  __dirname,
  "../../../util/public-policies-markdown.generated.ts",
);

function generatedModule(): string {
  const entries = BUILTIN_POLICIES.map((policy) => ({
    description: policy.description,
    markdown: policyMarkdown(policy),
    slug: policy.slug,
    title: policy.title,
    updated: policy.updated,
  }));
  return `/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// GENERATED from frontend/public/policies by markdown.test.tsx; do not edit.
// Regenerate: UPDATE_POLICY_MARKDOWN=1 pnpm -C src/packages/frontend exec jest public/policies/markdown.test.tsx

export interface PublicPolicyMarkdown {
  description: string;
  markdown: string;
  slug: string;
  title: string;
  updated: string;
}

export const PUBLIC_POLICY_MARKDOWN: readonly PublicPolicyMarkdown[] = ${JSON.stringify(entries, null, 2)};
`;
}

const md = new MarkdownIt();

function markdownDom(markdown: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = md.render(markdown);
  return div;
}

function headings(root: ParentNode): string[] {
  return [...root.querySelectorAll("h1, h2, h3, h4")].map(
    (h) => `${h.tagName} ${h.textContent?.replace(/\s+/g, " ").trim()}`,
  );
}

const BLOCKS = new Set([
  "BLOCKQUOTE",
  "BR",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

// Wording: the words in order, with whitespace collapsed, and a space at
// every block boundary (paragraphs, list items, cells), so layout doesn't
// matter but a lost space between two words does.
function words(root: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    const block = BLOCKS.has((node as Element).tagName);
    if (block) parts.push(" ");
    node.childNodes.forEach(walk);
    if (block) parts.push(" ");
  };
  walk(root);
  return parts.join("").replace(/\s+/g, " ").trim();
}

describe.each(BUILTIN_POLICIES.map((policy) => [policy.slug, policy]))(
  "policy Markdown: %s",
  (_slug, policy) => {
    const markdown = policyMarkdown(policy);

    it("is non-empty and says when it was updated", () => {
      expect(markdown.split(/^## /m).length).toBeGreaterThan(0);
      expect(markdown.length).toBeGreaterThan(500);
      expect(markdown).toContain(`Last Updated: ${policy.updated}`);
    });

    it("has the page's headings", () => {
      const prepared = preparePolicyContent(policy.content);
      const page = render(
        <PolicyDocument
          content={prepared.content}
          policy={policy}
          siteName="CoCalc"
        />,
      );
      expect(headings(markdownDom(markdown))).toEqual(headings(page.container));
      page.unmount();
    });

    it("has the page's text", () => {
      const page = render(<>{policy.content}</>);
      const body = markdown.split("\n\n").slice(2).join("\n\n");
      expect(words(markdownDom(body))).toEqual(words(page.container));
      page.unmount();
    });
  },
);

it("spacing at the edges of a link label stays outside the link", () => {
  const policy = {
    ...BUILTIN_POLICIES[0],
    content: (
      <p>
        The history can be found at
        <a href="https://github.com/sagemathinc/cocalc">
          {" "}
          github.com/sagemathinc/cocalc{" "}
        </a>
        today.
      </p>
    ),
  };
  const markdown = policyMarkdown(policy);
  expect(markdown).toContain(
    "found at [github.com/sagemathinc/cocalc](https://github.com/sagemathinc/cocalc) today.",
  );
});

it("the copy served by the hub is current", () => {
  const expected = generatedModule();
  if (process.env.UPDATE_POLICY_MARKDOWN === "1") {
    writeFileSync(GENERATED, expected);
  }
  expect(readFileSync(GENERATED, "utf8")).toEqual(expected);
});
