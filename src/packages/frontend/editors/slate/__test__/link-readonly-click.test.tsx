/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";

const mockUseProcessLinks = jest.fn(() => ({ current: null }));
const mockUseReadOnly = jest.fn();
const mockOpenNewTab = jest.fn();

jest.mock("../elements/hooks", () => ({
  useProcessLinks: (...args: any[]) => mockUseProcessLinks(...args),
  useReadOnly: () => mockUseReadOnly(),
}));

jest.mock("@cocalc/frontend/components", () => {
  const React = require("react");
  return {
    Tooltip: ({ children, title }: { children: any; title?: string }) =>
      React.createElement("span", { title }, children),
  };
});

jest.mock("@cocalc/frontend/misc", () => ({
  open_new_tab: (...args: any[]) => mockOpenNewTab(...args),
}));

import "../elements/link/editable";
import { getRender } from "../elements/register";

const URL = "https://example.com";

function renderLink({ readOnly }: { readOnly: boolean }): HTMLAnchorElement {
  mockUseReadOnly.mockReturnValue(readOnly);
  const LinkElement = getRender("link");
  render(
    <LinkElement
      attributes={{} as any}
      element={
        {
          type: "link",
          isInline: true,
          url: URL,
          title: "Example",
          children: [{ text: "Example" }],
        } as any
      }
    >
      <span>Example</span>
    </LinkElement>,
  );
  return screen.getByRole("link", { name: "Example" }) as HTMLAnchorElement;
}

describe("Slate link click behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens editable links only on double click", () => {
    const link = renderLink({ readOnly: false });

    expect(mockUseProcessLinks).toHaveBeenLastCalledWith([URL], {
      doubleClick: true,
    });
    expect(fireEvent.click(link)).toBe(false);

    fireEvent.doubleClick(link);
    expect(mockOpenNewTab).toHaveBeenCalledWith(URL);
  });

  it("lets read-only links open on single click", () => {
    const link = renderLink({ readOnly: true });

    expect(mockUseProcessLinks).toHaveBeenLastCalledWith([URL], {
      doubleClick: false,
    });
    expect(fireEvent.click(link)).toBe(true);

    fireEvent.doubleClick(link);
    expect(mockOpenNewTab).not.toHaveBeenCalled();
  });
});
