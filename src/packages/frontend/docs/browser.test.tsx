/** @jest-environment jsdom */

const mockListHosts = jest.fn(async () => []);
const mockGetConnectionTargets = jest.fn(() => []);
const mockProbeConnectionTarget = jest.fn(async () => undefined);

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      getConnectionTargets: (...args: any[]) =>
        mockGetConnectionTargets(...args),
      probeConnectionTarget: (...args: any[]) =>
        mockProbeConnectionTarget(...args),
      hub: {
        hosts: {
          listHosts: (...args: any[]) => mockListHosts(...args),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/projects/select-project", () => ({
  SelectProject: () => <div>Select project</div>,
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { docsPath, getDocsEntry, listDocsEntries } from "@cocalc/docs";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import {
  URL_REJECTED,
  type UrlTransformResult,
} from "@cocalc/frontend/lib/url-transform";
import {
  DocsBrowser,
  DocsMarkdown,
  docsEntryForInternalHref,
  normalizeDocsMarkdownValue,
} from "./browser";

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/",
}));

describe("DocsMarkdown link navigation", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it.each(["/docs", "/app-docs"])(
    "passes the original %s link, query and fragment to the selected-page callback",
    (prefix) => {
      const onInternalDocsLink = jest.fn();
      const href = `${prefix}/ai/codex-goals?from=sidebar#answer-questions-from-codex`;
      render(
        <DocsMarkdown
          onInternalDocsLink={onInternalDocsLink}
          value={`[**Read the guide**](${href})`}
        />,
      );
      const event = new MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
      });

      fireEvent(screen.getByText("Read the guide"), event);

      expect(event.defaultPrevented).toBe(true);
      expect(onInternalDocsLink).toHaveBeenCalledTimes(1);
      expect(onInternalDocsLink).toHaveBeenCalledWith(
        getDocsEntry("ai/codex-goals"),
        href,
      );
    },
  );

  it.each([
    { name: "Alt", options: { altKey: true } },
    { name: "Control", options: { ctrlKey: true } },
    { name: "Command", options: { metaKey: true } },
    { name: "Shift", options: { shiftKey: true } },
    { name: "middle button", options: { button: 1 } },
    { name: "secondary button", options: { button: 2 } },
    { name: "new tab", target: "_blank" },
    { name: "named browsing context", target: "docs-frame" },
    { name: "download", download: "guide.html" },
    {
      name: "external origin",
      href: "https://example.com/docs/ai/codex-goals#answer-questions-from-codex",
    },
    {
      name: "protocol-relative external origin",
      href: "//example.com/docs/ai/codex-goals#answer-questions-from-codex",
    },
  ])("preserves normal browser behavior for $name", (scenario) => {
    const onInternalDocsLink = jest.fn();
    const href =
      scenario.href ?? "/docs/ai/codex-goals#answer-questions-from-codex";
    render(
      <DocsMarkdown
        onInternalDocsLink={onInternalDocsLink}
        value={`[Read the guide](${href})`}
      />,
    );
    const link = screen.getByRole("link", { name: "Read the guide" });
    // Static Markdown opens absolute URLs in a new tab. Remove that default
    // so the origin checks are exercised independently of the target guard.
    link.removeAttribute("target");
    if (scenario.target) link.setAttribute("target", scenario.target);
    if (scenario.download) link.setAttribute("download", scenario.download);
    const event = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
      ...scenario.options,
    });

    fireEvent(link, event);

    expect(event.defaultPrevented).toBe(false);
    expect(onInternalDocsLink).not.toHaveBeenCalled();
  });

  it.each([
    { name: "Control-click", options: { ctrlKey: true } },
    { name: "Command-click", options: { metaKey: true } },
    { name: "middle-click", options: { button: 1 } },
    { name: "new tab", target: "_blank" },
    { name: "download", download: "guide.html" },
  ])("renders the correct prefixed destination for $name", (scenario) => {
    jest.replaceProperty(
      jest.requireMock("@cocalc/frontend/customize/app-base-path"),
      "appBasePath",
      "/prefix",
    );
    window.history.replaceState({}, "", "/prefix/docs/ai/my-agents");
    const onInternalDocsLink = jest.fn();
    render(
      <DocsMarkdown
        hrefForEntry={(entry) => `/prefix${docsPath(entry.slug)}`}
        onInternalDocsLink={onInternalDocsLink}
        value="[Read the guide](/docs/ai/codex-goals?from=sidebar#answer-questions-from-codex)"
      />,
    );
    const link = screen.getByRole("link", { name: "Read the guide" });
    expect(link).toHaveAttribute(
      "href",
      "/prefix/docs/ai/codex-goals?from=sidebar#answer-questions-from-codex",
    );
    if (scenario.target) link.setAttribute("target", scenario.target);
    if (scenario.download) link.setAttribute("download", scenario.download);
    const event = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
      ...scenario.options,
    });

    fireEvent(link, event);

    expect(event.defaultPrevented).toBe(false);
    expect(onInternalDocsLink).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/prefix/docs/ai/my-agents");
  });

  describe("raw HTML anchors", () => {
    const href = "/docs/ai/codex-goals?from=raw#answer-questions-from-codex";
    const prefixedHref = `/prefix${href}`;

    beforeEach(() => {
      jest.replaceProperty(
        jest.requireMock("@cocalc/frontend/customize/app-base-path"),
        "appBasePath",
        "/prefix",
      );
      window.history.replaceState({}, "", "/prefix/docs/ai/my-agents");
    });

    it.each([href, prefixedHref])(
      "maps and follows %s without doubling the base path",
      (sourceHref) => {
        const onInternalDocsLink = jest.fn();
        render(
          <DocsMarkdown
            hrefForEntry={(entry) => `/prefix${docsPath(entry.slug)}`}
            onInternalDocsLink={onInternalDocsLink}
            value={`<div><a name='raw-docs-link' href='${sourceHref}'><strong>Read guide</strong></a></div>`}
          />,
        );
        const link = screen.getByRole("link", { name: "Read guide" });
        const label = screen.getByText("Read guide");
        expect(link).toHaveAttribute("href", prefixedHref);
        // This attribute survives raw HTML rendering but is discarded when
        // inline anchors are converted to ordinary Slate links.
        expect(link).toHaveAttribute("name", "raw-docs-link");
        expect(label.tagName).toBe("STRONG");
        const event = new MouseEvent("click", {
          bubbles: true,
          button: 0,
          cancelable: true,
        });

        fireEvent(label, event);

        expect(event.defaultPrevented).toBe(true);
        expect(onInternalDocsLink).toHaveBeenCalledTimes(1);
        expect(onInternalDocsLink).toHaveBeenCalledWith(
          getDocsEntry("ai/codex-goals"),
          prefixedHref,
        );
        expect(window.location.pathname).toBe("/prefix/docs/ai/my-agents");
      },
    );

    it("keeps Command-click native with the mapped destination", () => {
      const onInternalDocsLink = jest.fn();
      render(
        <DocsMarkdown
          hrefForEntry={(entry) => `/prefix${docsPath(entry.slug)}`}
          onInternalDocsLink={onInternalDocsLink}
          value={`<div><a name='raw-docs-link' href='${href}'><strong>Read guide</strong></a></div>`}
        />,
      );
      const link = screen.getByRole("link", { name: "Read guide" });
      expect(link).toHaveAttribute("href", prefixedHref);
      expect(link).toHaveAttribute("name", "raw-docs-link");
      const event = new MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        metaKey: true,
      });

      fireEvent(screen.getByText("Read guide"), event);

      expect(event.defaultPrevented).toBe(false);
      expect(onInternalDocsLink).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe("/prefix/docs/ai/my-agents");
    });

    it("preserves an inherited FileContext URL rejection", () => {
      const urlTransform = jest.fn(
        (_url: string, tag?: string): UrlTransformResult =>
          tag === "a" ? URL_REJECTED : undefined,
      );
      const hrefForEntry = jest.fn(() => "/prefix/docs/ai/codex-goals");
      const onInternalDocsLink = jest.fn();
      render(
        <FileContext.Provider value={{ urlTransform }}>
          <DocsMarkdown
            hrefForEntry={hrefForEntry}
            onInternalDocsLink={onInternalDocsLink}
            value={`<div><a name='raw-docs-link' href='${href}'><strong>Read guide</strong></a></div>`}
          />
        </FileContext.Provider>,
      );
      const label = screen.getByText("Read guide");
      expect(urlTransform).toHaveBeenCalledWith(href, "a");
      const anchor = label.closest("a");
      expect(anchor).toHaveAttribute("name", "raw-docs-link");
      expect(anchor).not.toHaveAttribute("href");
      expect(screen.queryByRole("link", { name: "Read guide" })).toBeNull();
      expect(hrefForEntry).not.toHaveBeenCalled();
      const event = new MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
      });

      fireEvent(label, event);

      expect(event.defaultPrevented).toBe(false);
      expect(onInternalDocsLink).not.toHaveBeenCalled();
    });
  });

  it("renders a prefixed same-page fragment for native browser scrolling", () => {
    jest.replaceProperty(
      jest.requireMock("@cocalc/frontend/customize/app-base-path"),
      "appBasePath",
      "/prefix",
    );
    window.history.replaceState(
      {},
      "",
      "/prefix/docs/ai/codex-goals?view=compact",
    );
    const onInternalDocsLink = jest.fn();
    render(
      <DocsMarkdown
        hrefForEntry={(entry) => `/prefix${docsPath(entry.slug)}`}
        onInternalDocsLink={onInternalDocsLink}
        value="[Read the answer section](/docs/ai/codex-goals?view=compact#answer-questions-from-codex)"
      />,
    );
    const link = screen.getByRole("link", { name: "Read the answer section" });
    expect(link).toHaveAttribute(
      "href",
      "/prefix/docs/ai/codex-goals?view=compact#answer-questions-from-codex",
    );
    const event = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });

    fireEvent(link, event);

    expect(event.defaultPrevented).toBe(false);
    expect(onInternalDocsLink).not.toHaveBeenCalled();
  });

  it("keeps a same-origin absolute link's native new-tab behavior", () => {
    jest.replaceProperty(
      jest.requireMock("@cocalc/frontend/customize/app-base-path"),
      "appBasePath",
      "/prefix",
    );
    const onInternalDocsLink = jest.fn();
    const origin = window.location.origin;
    render(
      <DocsMarkdown
        hrefForEntry={(entry) => `/prefix${docsPath(entry.slug)}`}
        onInternalDocsLink={onInternalDocsLink}
        value={`[Read the guide](${origin}/docs/ai/codex-goals?from=sidebar#answer-questions-from-codex)`}
      />,
    );
    const link = screen.getByRole("link", { name: "Read the guide" });
    expect(link).toHaveAttribute(
      "href",
      `${origin}/prefix/docs/ai/codex-goals?from=sidebar#answer-questions-from-codex`,
    );
    expect(link).toHaveAttribute("target", "_blank");
    const event = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });

    fireEvent(link, event);

    expect(event.defaultPrevented).toBe(false);
    expect(onInternalDocsLink).not.toHaveBeenCalled();
  });

  it("does not rewrite external or fragment links, image sources or code examples", () => {
    jest.replaceProperty(
      jest.requireMock("@cocalc/frontend/customize/app-base-path"),
      "appBasePath",
      "/prefix",
    );
    const example =
      "/docs/ai/codex-goals?from=example#answer-questions-from-codex";
    render(
      <DocsMarkdown
        hrefForEntry={(entry) => `/prefix${docsPath(entry.slug)}`}
        value={[
          "[External guide](https://example.com/docs/ai/codex-goals#section)",
          "[Local section](#section)",
          "[Unknown guide](/docs/not-registered#section)",
          `![Example illustration](${example})`,
          `Inline path: \`${example}\``,
          `\`\`\`text\n[Example link](${example})\n\`\`\``,
        ].join("\n\n")}
      />,
    );

    expect(
      screen.getByRole("link", { name: "External guide" }),
    ).toHaveAttribute(
      "href",
      "https://example.com/docs/ai/codex-goals#section",
    );
    expect(screen.getByRole("link", { name: "Local section" })).toHaveAttribute(
      "href",
      "#section",
    );
    expect(screen.getByRole("link", { name: "Unknown guide" })).toHaveAttribute(
      "href",
      "/docs/not-registered#section",
    );
    expect(
      screen.getByRole("img", { name: "Example illustration" }),
    ).toHaveAttribute("src", example);
    expect(screen.queryByRole("link", { name: "Example link" })).toBeNull();
    const codeText = Array.from(
      screen.getByTestId("docs-markdown").querySelectorAll("code"),
    )
      .map((code) => code.textContent)
      .join("\n");
    expect(codeText).toContain(example);
    expect(codeText).not.toContain(`/prefix${example}`);
  });

  it("applies inherited URL rewrites before docs canonicalization", () => {
    jest.replaceProperty(
      jest.requireMock("@cocalc/frontend/customize/app-base-path"),
      "appBasePath",
      "/prefix",
    );
    const urlTransform = jest.fn((url: string, tag?: string) => {
      if (url === "/help/goals" && tag === "a") {
        return "/docs/ai/codex-goals?from=inherited#answer-questions-from-codex";
      }
      if (url === "/asset/diagram.png" && tag === "img") {
        return "/media/diagram.png";
      }
      return undefined;
    });
    render(
      <FileContext.Provider value={{ urlTransform }}>
        <DocsMarkdown
          hrefForEntry={(entry) => `/prefix${docsPath(entry.slug)}`}
          value={[
            "[Read the guide](/help/goals)",
            "![Workflow diagram](/asset/diagram.png)",
          ].join("\n\n")}
        />
      </FileContext.Provider>,
    );

    expect(
      screen.getByRole("link", { name: "Read the guide" }),
    ).toHaveAttribute(
      "href",
      "/prefix/docs/ai/codex-goals?from=inherited#answer-questions-from-codex",
    );
    expect(
      screen.getByRole("img", { name: "Workflow diagram" }),
    ).toHaveAttribute("src", "/media/diagram.png");
    expect(urlTransform).toHaveBeenCalledWith("/help/goals", "a");
    expect(urlTransform).toHaveBeenCalledWith("/asset/diagram.png", "img");
  });

  it.each(["rejects", "throws"])(
    "does not restore a docs destination when the inherited transform %s",
    (behavior) => {
      const onInternalDocsLink = jest.fn();
      render(
        <FileContext.Provider
          value={{
            urlTransform: () => {
              if (behavior === "throws") throw new Error("URL denied");
              return URL_REJECTED;
            },
          }}
        >
          <DocsMarkdown
            hrefForEntry={(entry) => `/prefix${docsPath(entry.slug)}`}
            onInternalDocsLink={onInternalDocsLink}
            value="[Read the guide](/docs/ai/codex-goals#answer-questions-from-codex)"
          />
        </FileContext.Provider>,
      );
      const text = screen.getByText("Read the guide");
      expect(screen.queryByRole("link", { name: "Read the guide" })).toBeNull();
      expect(text.closest("a")).not.toHaveAttribute("href");

      fireEvent.click(text);

      expect(onInternalDocsLink).not.toHaveBeenCalled();
    },
  );

  it("does not override a click already handled by another listener", () => {
    const onInternalDocsLink = jest.fn();
    render(
      <DocsMarkdown
        onInternalDocsLink={onInternalDocsLink}
        value="[Read the guide](/docs/ai/codex-goals#answer-questions-from-codex)"
      />,
    );
    const event = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });
    event.preventDefault();

    fireEvent(screen.getByRole("link", { name: "Read the guide" }), event);

    expect(onInternalDocsLink).not.toHaveBeenCalled();
  });

  it.each([
    "#answer-questions-from-codex",
    "/docs/ai/codex-goals?view=compact#answer-questions-from-codex",
  ])("leaves a same-page fragment to native scrolling: %s", (href) => {
    window.history.replaceState({}, "", "/docs/ai/codex-goals?view=compact");
    const onInternalDocsLink = jest.fn();
    render(
      <DocsMarkdown
        onInternalDocsLink={onInternalDocsLink}
        value={`[Read the answer section](${href})`}
      />,
    );
    const event = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });

    fireEvent(
      screen.getByRole("link", { name: "Read the answer section" }),
      event,
    );

    expect(event.defaultPrevented).toBe(false);
    expect(onInternalDocsLink).not.toHaveBeenCalled();
  });
});

describe("DocsBrowser", () => {
  beforeEach(() => {
    mockListHosts.mockClear();
    mockGetConnectionTargets.mockClear();
    mockProbeConnectionTarget.mockClear();
  });

  it("normalizes escaped inline-code backticks from raw docs strings", () => {
    expect(normalizeDocsMarkdownValue("Open \\`/home/user\\`")).toBe(
      "Open `/home/user`",
    );
  });

  it("resolves internal docs markdown links without browser navigation", () => {
    expect(docsEntryForInternalHref("/docs/projects/publish-rootfs")?.id).toBe(
      "projects.publish-rootfs",
    );
    expect(
      docsEntryForInternalHref("/app-docs/projects/publish-files?x=1#top")?.id,
    ).toBe("projects.publish-files");
    expect(docsEntryForInternalHref("https://example.com/docs/projects")).toBe(
      undefined,
    );
  });

  it("uses supplied access without widening profile or visibility", () => {
    expect(
      docsEntryForInternalHref("/docs/projects/rstudio-project", {
        siteProfile: "cocalc-ai",
      })?.id,
    ).toBe("projects.rstudio-project");
    expect(
      docsEntryForInternalHref("/docs/projects/rstudio-project", {}),
    ).toBeUndefined();
    expect(
      docsEntryForInternalHref("/docs/admin/overview", {
        siteProfile: "cocalc-ai",
      }),
    ).toBeUndefined();
    expect(
      docsEntryForInternalHref("/docs/admin/overview", {
        siteProfile: "cocalc-ai",
        includeAdmin: true,
        includeSignedIn: true,
      })?.id,
    ).toBe("admin.overview");
    const signedInEntry = listDocsEntries({ includeSignedIn: true }).find(
      (entry) => entry.visibility === "signed-in",
    );
    expect(signedInEntry).toBeDefined();
    expect(
      docsEntryForInternalHref(`/docs/${signedInEntry!.slug}`, {}),
    ).toBeUndefined();
  });

  it("still selects the linked page inside the signed-in docs browser", () => {
    const entry = getDocsEntry("terminal/use-terminal");
    const nextEntry = getDocsEntry("projects/publish-files");
    if (!entry || !nextEntry) throw new Error("missing docs fixture");
    const onSelectedEntryChange = jest.fn();
    render(
      <DocsBrowser
        initialEntry={{
          ...entry,
          body: "[Open the publishing guide](/app-docs/projects/publish-files?from=terminal#top)",
        }}
        onSelectedEntryChange={onSelectedEntryChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("link", { name: "Open the publishing guide" }),
    );

    // This checks in-app page selection only; section scrolling is separate.
    expect(onSelectedEntryChange).toHaveBeenCalledWith(nextEntry);
    expect(
      screen.getByRole("heading", { level: 1, name: nextEntry.title }),
    ).toBeInTheDocument();
  });

  it("includes the exam scratchpad guide in the app docs registry", () => {
    expect(getDocsEntry("hosts/exam-scratchpads")?.id).toBe(
      "hosts.exam-scratchpads",
    );
  });

  it("notifies when the detail view returns to the index", () => {
    const entry = getDocsEntry("terminal/use-terminal");
    if (entry == null) throw new Error("missing terminal docs entry");
    const onSelectedEntryChange = jest.fn();

    render(
      <DocsBrowser
        initialEntry={entry}
        onSelectedEntryChange={onSelectedEntryChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /All docs/ }));

    expect(onSelectedEntryChange).toHaveBeenCalledWith(undefined);
  });

  it("shows a compact table of contents and opens pages from it", () => {
    const entry = getDocsEntry("terminal/use-terminal");
    if (entry == null) throw new Error("missing terminal docs entry");
    const onSelectedEntryChange = jest.fn();

    render(<DocsBrowser onSelectedEntryChange={onSelectedEntryChange} />);

    expect(screen.getByText("Table of contents")).toBeTruthy();

    const tocButton = screen.getAllByText(entry.title)[0].closest("button");
    if (tocButton == null) throw new Error("missing table of contents button");
    fireEvent.click(tocButton);

    expect(onSelectedEntryChange).toHaveBeenCalledWith(entry);
    expect(screen.getByRole("heading", { name: entry.title })).toBeTruthy();
  });

  it("shows table of contents progress and continues to the first unlearned page", () => {
    const entries = listDocsEntries();
    const firstEntry = entries[0];
    const secondEntry = entries[1];
    if (firstEntry == null || secondEntry == null) {
      throw new Error("missing docs entries");
    }
    const onSelectedEntryChange = jest.fn();

    render(
      <DocsBrowser
        onSelectedEntryChange={onSelectedEntryChange}
        privateIndexState={{
          enabled: true,
          filter: "all",
          onFilterChange: jest.fn(),
          summaries: {
            [firstEntry.id]: {
              learnedAt: 1,
              lastViewedAt: 1,
              noteCount: 0,
              noteText: "",
              starred: false,
            },
          },
        }}
      />,
    );

    expect(screen.getAllByText(/1 \/ .* learned/)[0]).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Continue learning/ }));

    expect(onSelectedEntryChange).toHaveBeenCalledWith(secondEntry);
    expect(
      screen.getByRole("heading", { level: 1, name: secondEntry.title }),
    ).toBeTruthy();
  });

  it("does not show redundant chapter cards below the table of contents", () => {
    render(<DocsBrowser />);

    expect(screen.getByText("Table of contents")).toBeTruthy();
    expect(
      screen.queryByText(/Create projects, choose runtime settings/),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Start chapter/ })).toBeNull();
  });

  it("uses a callback for app print-friendly docs", () => {
    const onPrint = jest.fn();

    render(<DocsBrowser onPrint={onPrint} />);

    fireEvent.click(screen.getByRole("button", { name: /Print-friendly/ }));

    expect(onPrint).toHaveBeenCalled();
  });

  it("renders all docs in a print-friendly single page mode", () => {
    render(<DocsBrowser browserHref="/app-docs" printMode />);

    expect(
      screen.getByRole("heading", { name: "Complete documentation" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Back to docs/ }).getAttribute("href"),
    ).toBe("/app-docs");
    expect(screen.getByText("Print")).toBeTruthy();
  });

  it("navigates linearly within the current docs category", () => {
    const allEntries = listDocsEntries();
    const entry = allEntries.find(
      (candidate) =>
        allEntries.filter((entry) => entry.category === candidate.category)
          .length > 1,
    );
    if (entry == null) throw new Error("missing multi-page docs category");
    const categoryEntries = allEntries.filter(
      (candidate) => candidate.category === entry.category,
    );
    const currentIndex = categoryEntries.findIndex(
      (candidate) => candidate.id === entry.id,
    );
    const nextEntry = categoryEntries[currentIndex + 1];
    if (nextEntry == null) throw new Error("missing next terminal docs entry");
    const onSelectedEntryChange = jest.fn();

    render(
      <DocsBrowser
        initialEntry={entry}
        onSelectedEntryChange={onSelectedEntryChange}
      />,
    );

    expect(
      screen.getAllByText(
        `Page ${currentIndex + 1} of ${categoryEntries.length} in ${
          entry.category
        }`,
      )[0],
    ).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /Next/ })[0]);

    expect(onSelectedEntryChange).toHaveBeenCalledWith(nextEntry);
    expect(screen.getByRole("heading", { name: nextEntry.title })).toBeTruthy();
  });

  it("advances from the last page of a category to the next chapter", () => {
    const allEntries = listDocsEntries();
    const categoryOrder = Array.from(
      new Set(allEntries.map((entry) => entry.category)),
    );
    const category = categoryOrder.find((candidate, index) => {
      const nextCategory = categoryOrder[index + 1];
      return (
        nextCategory != null &&
        allEntries.filter((entry) => entry.category === candidate).length > 1
      );
    });
    if (category == null) throw new Error("missing next docs chapter");
    const categoryEntries = allEntries.filter(
      (entry) => entry.category === category,
    );
    const entry = categoryEntries[categoryEntries.length - 1];
    const entryIndex = allEntries.findIndex(
      (candidate) => candidate.id === entry.id,
    );
    const nextChapter = allEntries
      .slice(entryIndex + 1)
      .find((candidate) => candidate.category !== entry.category);
    if (nextChapter == null) throw new Error("missing next chapter entry");
    const onSelectedEntryChange = jest.fn();

    render(
      <DocsBrowser
        initialEntry={entry}
        onSelectedEntryChange={onSelectedEntryChange}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /Next Chapter/ })[0]);

    expect(onSelectedEntryChange).toHaveBeenCalledWith(nextChapter);
    expect(
      screen.getByRole("heading", { level: 1, name: nextChapter.title }),
    ).toBeTruthy();
  });

  it("goes from the first page of a category to the previous chapter", () => {
    const allEntries = listDocsEntries();
    const categoryOrder = Array.from(
      new Set(allEntries.map((entry) => entry.category)),
    );
    const category = categoryOrder.find((candidate, index) => {
      const previousCategory = categoryOrder[index - 1];
      return (
        previousCategory != null &&
        allEntries.some((entry) => entry.category === candidate)
      );
    });
    if (category == null) throw new Error("missing previous docs chapter");
    const entry = allEntries.find(
      (candidate) => candidate.category === category,
    );
    if (entry == null) throw new Error("missing first chapter entry");
    const entryIndex = allEntries.findIndex(
      (candidate) => candidate.id === entry.id,
    );
    const previousChapter = allEntries
      .slice(0, entryIndex)
      .reverse()
      .find((candidate) => candidate.category !== entry.category);
    if (previousChapter == null)
      throw new Error("missing previous chapter entry");
    const onSelectedEntryChange = jest.fn();

    render(
      <DocsBrowser
        initialEntry={entry}
        onSelectedEntryChange={onSelectedEntryChange}
      />,
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: /Previous Chapter/ })[0],
    );

    expect(onSelectedEntryChange).toHaveBeenCalledWith(previousChapter);
    expect(
      screen.getByRole("heading", { name: previousChapter.title }),
    ).toBeTruthy();
  });

  it("loads all visible hosts for project host action parameters", async () => {
    const entry = getDocsEntry("hosts/access-and-ram");
    if (entry == null)
      throw new Error("missing project host access docs entry");

    render(<DocsBrowser initialEntry={entry} onRunAction={jest.fn()} />);

    await waitFor(() =>
      expect(mockListHosts).toHaveBeenCalledWith({ show_all: true }),
    );
  });
});
