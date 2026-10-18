/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

jest.mock("../alerts", () => ({ alert_message: jest.fn() }));

import { isScriptUrl, open_new_tab } from "./open-browser-tab";

describe("open_new_tab", () => {
  let open: jest.SpyInstance;
  beforeEach(() => {
    open = jest
      .spyOn(window, "open")
      .mockImplementation(() => ({ closed: false }) as any);
  });
  afterEach(() => open.mockRestore());

  it.each([
    "javascript:void 0",
    " JavaScript:void 0",
    "java\tscript:void 0",
    "\u0001javascript:void 0",
    "vbscript:x",
  ])("never opens a script URL: %j", (url) => {
    expect(isScriptUrl(url)).toBe(true);
    expect(open_new_tab(url)).toBeNull();
    expect(open_new_tab(url, true)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["https://example.com/x", "/projects/x/files/a.md", "mailto:a@b.c"])(
    "opens %s",
    (url) => {
      open_new_tab(url);
      expect(open).toHaveBeenCalledWith(url, "_blank");
    },
  );
});

describe("open_new_tab opener", () => {
  afterEach(() => jest.restoreAllMocks());

  it("detaches the opened tab from this page by default", () => {
    const tab: any = { closed: false, opener: window };
    jest.spyOn(window, "open").mockImplementation(() => tab);
    expect(open_new_tab("https://example.com/")).toBe(tab);
    expect(tab.opener).toBeNull();
  });
});
