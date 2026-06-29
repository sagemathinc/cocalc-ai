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

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { getDocsEntry, listDocsEntries } from "@cocalc/docs";
import {
  DocsBrowser,
  docsEntryForInternalHref,
  normalizeDocsMarkdownValue,
} from "./browser";

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
      screen.getByRole("heading", { name: secondEntry.title }),
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
        allEntries.some((entry) => entry.category === candidate)
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
      screen.getByRole("heading", { name: nextChapter.title }),
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
