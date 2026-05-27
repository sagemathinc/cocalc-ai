/** @jest-environment jsdom */

const mockListHosts = jest.fn(async () => []);

if (global.MessageChannel == null) {
  (global as any).MessageChannel = class {
    port1 = {
      close: jest.fn(),
      onmessage: undefined as ((event: MessageEvent) => void) | undefined,
    };
    port2 = {
      close: jest.fn(),
      postMessage: (data: unknown) =>
        setTimeout(() => this.port1.onmessage?.({ data } as MessageEvent), 0),
    };
  };
}

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
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
import { DocsBrowser } from "./browser";

describe("DocsBrowser", () => {
  beforeEach(() => {
    mockListHosts.mockClear();
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
