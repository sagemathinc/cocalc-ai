/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

jest.mock("@cocalc/frontend/alerts", () => ({ alert_message: jest.fn() }));

import { activateTerminalLink, isOpenableTerminalLink } from "./terminal-links";

describe("OSC 8 terminal links", () => {
  let open: jest.SpyInstance;
  let confirm: jest.SpyInstance;
  let tab: any;
  beforeEach(() => {
    tab = { closed: false, opener: window };
    open = jest.spyOn(window, "open").mockImplementation(() => tab);
    confirm = jest.spyOn(window, "confirm").mockImplementation(() => true);
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const event = {} as MouseEvent;

  it.each([
    "javascript:void 0",
    " JavaScript:void 0",
    "data:text/plain,hello",
    "file:///etc/hostname",
    "not a url",
  ])("never opens %j", (uri) => {
    expect(isOpenableTerminalLink(uri)).toBe(false);
    activateTerminalLink(event, uri);
    expect(confirm).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["https://example.com/a", "http://example.com/", "mailto:a@b.c"])(
    "opens %s in a new tab without an opener after confirmation",
    (uri) => {
      activateTerminalLink(event, uri);
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining(uri));
      expect(open).toHaveBeenCalledWith(uri, "_blank");
      expect(tab.opener).toBeNull();
    },
  );

  it("does nothing when the user declines", () => {
    confirm.mockImplementation(() => false);
    activateTerminalLink(event, "https://example.com/");
    expect(open).not.toHaveBeenCalled();
  });
});
