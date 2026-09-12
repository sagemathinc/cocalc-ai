import { getDocsEntry, listDocsEntries } from "@cocalc/docs";
import { renderPublicDocsPrerender } from "./public-docs-prerender";

const config = { dns: "cocalc.ai", site_name: "CoCalc" };
const entry = getDocsEntry("projects/create-project")!;
const originalBody = entry.body;

function detail(slug: string, basePath = "/", siteConfig = config) {
  return renderPublicDocsPrerender(
    { section: "docs", route: { view: "docs-detail", slug } },
    basePath,
    siteConfig,
  );
}

afterEach(() => {
  entry.body = originalBody;
});

describe("public docs initial HTML", () => {
  it("renders a complete registry article with semantic Markdown", () => {
    entry.body = `Introductory **paragraph** with \`code\`.

## Check café and \`results\`

- First item
- Second item

| Input | Result |
| --- | --- |
| 2 | 4 |

~~~python
if value < 4:
    print("checked")
~~~
`;
    const html = detail(entry.slug);
    expect(html).toContain('data-cocalc-public-prerender="docs-detail"');
    expect(html).toContain(`<h1>${entry.title}</h1>`);
    expect(html).toContain("Introductory <strong>paragraph</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<h2 id="check-cafe-and-results">');
    expect(html).toContain("<li>First item</li>");
    expect(html).toContain("<table>");
    expect(html).toContain(
      '<div style="max-width:100%;overflow-x:auto" tabindex="0"><table>',
    );
    expect(html).toContain("<td>4</td>");
    expect(html).toContain('<pre><code class="language-python">');
    expect(html).toContain(
      '<div style="max-width:100%;overflow-x:auto" tabindex="0"><pre>',
    );
    expect(html).toContain("if value &lt; 4:");
    expect(html).toContain("    print(&quot;checked&quot;)");
  });

  it("normalizes legacy escaped backticks like the interactive docs", () => {
    entry.body = "Use \\`/home/user\\` for the example.";
    expect(detail(entry.slug)).toContain("<code>/home/user</code>");
  });

  it("renders only anonymous-visible index entries for the deployment", () => {
    const html = renderPublicDocsPrerender(
      { section: "docs", route: { view: "docs-index" } },
      "/",
      config,
    );
    for (const item of listDocsEntries({ siteProfile: "cocalc-ai" })) {
      expect(html).toContain(`href="/docs/${item.slug}"`);
    }
    expect(html).toContain("<h1>CoCalc documentation</h1>");
    expect(html).not.toContain('href="/docs/admin/users"');
    expect(html).not.toContain('href="/docs/account/settings"');
    expect(html).not.toContain('href="/docs/projects/virtual-machines"');

    const otherSite = renderPublicDocsPrerender(
      { section: "docs", route: { view: "docs-index" } },
      "/",
      { dns: "university.example.edu" },
    );
    expect(otherSite).not.toContain('href="/docs/projects/rstudio-project"');

    const plus = renderPublicDocsPrerender(
      { section: "docs", route: { view: "docs-index" } },
      "/",
      { ...config, cocalc_product: "plus" },
    );
    expect(plus).not.toContain('href="/docs/hosts/project-hosts"');
  });

  it("never renders restricted, feature-disabled, or unknown bodies", () => {
    for (const slug of [
      "admin/users",
      "account/settings",
      "projects/virtual-machines",
      "does-not-exist",
    ]) {
      expect(detail(slug)).toBe("");
    }
    expect(
      detail("projects/rstudio-project", "/", {
        dns: "university.example.edu",
        site_name: "University",
      }),
    ).toBe("");
  });

  it("keeps site links and fragments on the deployment base path", () => {
    entry.body = `## Read the results

[Local](/docs/files/project-files?q=1#section)
[Already prefixed](/prefix/docs/files/project-files?q=1#section)
[Fragment](#read-the-results)
[External](https://example.com/docs/other#section)
[Protocol relative](//example.com/docs/other)
![Diagram](/assets/diagram.png)
`;
    const html = detail(entry.slug, "/prefix");
    expect(html).toContain('href="/prefix/docs"');
    expect(
      html.match(/href="\/prefix\/docs\/files\/project-files\?q=1#section"/g),
    ).toHaveLength(2);
    expect(html).toContain(
      `href="/prefix/docs/${entry.slug}#read-the-results"`,
    );
    expect(html).toContain('id="read-the-results"');
    expect(html).toContain('href="https://example.com/docs/other#section"');
    expect(html).toContain('href="//example.com/docs/other"');
    expect(html).toContain('src="/prefix/assets/diagram.png"');
    expect(html).toContain('style="max-width:100%;height:auto"');
    expect(html).not.toContain("/prefix/prefix/");
    const root = detail(entry.slug);
    expect(root).toContain('href="/docs/files/project-files?q=1#section"');
    expect(root).toContain(`href="/docs/${entry.slug}#read-the-results"`);
  });

  it("escapes raw HTML and preserves the parser's unsafe-link rejection", () => {
    entry.body = `## Safe body

<script>alert("script")</script>

<img src="x" onerror="alert(1)">

[Unsafe](javascript:alert(1))
[Data](data:text/html;base64,PHNjcmlwdD4=)

~~~html
<script>code example</script>
~~~
`;
    const html = detail(entry.slug);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('<img src="x"');
    expect(html).not.toMatch(/href="(?:javascript|data):/i);
    expect(html).toContain("&lt;script&gt;code example&lt;/script&gt;");
  });

  it("leaves print and non-doc routes to their existing client renderers", () => {
    for (const route of [
      { section: "docs", route: { view: "docs-print" } },
      { section: "features", route: { view: "detail", slug: "python" } },
    ]) {
      expect(renderPublicDocsPrerender(route, "/", config)).toBe("");
    }
  });
});
