/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

jest.mock("@cocalc/frontend/alerts", () => ({ alert_message: jest.fn() }));

import { activateTerminalLink, openableTerminalLink } from "./terminal-links";

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
    "mailto:a@b.c",
    "not a url",
  ])("never opens %j", (uri) => {
    expect(openableTerminalLink(uri)).toBeUndefined();
    activateTerminalLink(event, uri);
    expect(confirm).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ["https://example.com/a", "https://example.com/a"],
    ["http://example.com", "http://example.com/"],
    ["HTTPS://Example.COM/a b", "https://example.com/a%20b"],
  ])(
    "opens %s as %s in a new tab without an opener after confirmation",
    (uri, href) => {
      activateTerminalLink(event, uri);
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining(href));
      expect(open).toHaveBeenCalledWith(href, "_blank");
      expect(tab.opener).toBeNull();
    },
  );

  it("does nothing when the user declines", () => {
    confirm.mockImplementation(() => false);
    activateTerminalLink(event, "https://example.com/");
    expect(open).not.toHaveBeenCalled();
  });
});
