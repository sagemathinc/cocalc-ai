import { render } from "@testing-library/react";
import MarkdownIt from "markdown-it";
import { BUILTIN_POLICIES } from "./registry";
import { PolicyDocument } from "./policy";
import { policyMarkdown } from "./markdown";

const parser = new MarkdownIt();
// DOM textContent does not insert spaces at nested list/table boundaries.
const normalize = (text: string) => text.replace(/\s+/g, "");

test.each(BUILTIN_POLICIES.map((policy) => [policy.slug, policy] as const))(
  "%s Markdown preserves the page headings, prose, lists, tables, and date",
  (_slug, policy) => {
    const { container } = render(
      <PolicyDocument policy={policy} siteName="CoCalc" />,
    );
    const markdown = policyMarkdown(policy);
    expect(markdown.length).toBeGreaterThan(200);
    expect(markdown).toContain(`Last Updated: ${policy.updated}`);
    const exported = document.createElement("div");
    exported.innerHTML = parser.render(markdown);
    const headings = (root: HTMLElement) =>
      Array.from(
        root.querySelectorAll("h1,h2,h3"),
        (heading) => heading.textContent,
      );
    expect(headings(exported)).toEqual(headings(container));
    const text = normalize(exported.textContent ?? "");
    for (const element of container.querySelectorAll("p,li,th,td")) {
      // The page prefixes the date with its deployment's brand.
      if (element.textContent?.includes("Last Updated:")) continue;
      const copy = element.cloneNode(true) as HTMLElement;
      // Check nested blocks independently rather than relying on the DOM's
      // missing separators around their textContent.
      for (const block of copy.querySelectorAll("ul,ol,p,table"))
        block.remove();
      expect(text).toContain(normalize(copy.textContent ?? ""));
    }
    expect(exported.querySelectorAll("table").length).toBe(
      container.querySelectorAll("table").length,
    );
    const links = (root: HTMLElement) =>
      Array.from(
        root.querySelectorAll("a[href]"),
        (link) => new URL(link.getAttribute("href")!, "https://cocalc.ai").href,
      );
    expect(links(exported)).toEqual(links(container));
  },
);
