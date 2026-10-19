/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

// A link in the editable Markdown editor is linked and opened (double click)
// only if its URL is safe, as in the read-only renderer.

import { fireEvent, render } from "@testing-library/react";
import { EditableMarkdown } from "../editable-markdown";

jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

function renderEditable(value: string) {
  return render(
    <EditableMarkdown
      value={value}
      is_current
      enableUpload={false}
      minimal
      hidePath
      disableWindowing
      noVfill
      showEditBar={false}
      height="auto"
    />,
  ).container;
}

describe("editable Markdown links", () => {
  let open: jest.SpyInstance;
  beforeEach(() => {
    open = jest
      .spyOn(window, "open")
      .mockImplementation(() => ({ closed: false }) as any);
  });
  afterEach(() => open.mockRestore());

  function anchor(container: HTMLElement, text: string): HTMLAnchorElement {
    const a = [...container.querySelectorAll("a")].find((x) =>
      x.textContent?.includes(text),
    );
    expect(a).toBeDefined();
    return a as HTMLAnchorElement;
  }

  // Markdown never even produces a link node for a script URL (markdown-it
  // rejects it); the link element's own check and open_new_tab's refusal
  // (misc/open-browser-tab.test.ts) cover link nodes made any other way.
  it("a script URL in Markdown is neither linked nor opened", () => {
    const container = renderEditable("See [this](javascript:void%200) link.\n");
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i);
      fireEvent.doubleClick(a);
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("a normal URL is linked and opens on double click", () => {
    const a = anchor(
      renderEditable("See [this](https://example.com/x) link.\n"),
      "this",
    );
    expect(a.getAttribute("href")).toBe("https://example.com/x");
    fireEvent.doubleClick(a);
    expect(open).toHaveBeenCalledWith("https://example.com/x", "_blank");
  });
});
