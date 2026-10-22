/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/components", () => ({ HTML: () => null }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  React: {},
  Redux: () => null,
  redux: {},
}));
jest.mock("@cocalc/frontend/misc", () => ({ BASE_URL: "" }));
jest.mock("@cocalc/frontend/misc/resource-links", () => ({
  resource_links_string: () => "",
}));
jest.mock("@cocalc/frontend/misc/print-document", () => ({
  writePassiveDocument: jest.fn(),
}));

import { print_html } from "./print";

function openPopup() {
  const popupWindow: any = { print: jest.fn(), onload: null };
  const w = { window: popupWindow, closed: false };
  jest.spyOn(window, "open").mockReturnValue(w as any);
  return popupWindow;
}

it("a self-printing page is only opened: it prints itself once loaded", () => {
  const popupWindow = openPopup();
  print_html({ src: "/content-view/p/a.html?print=1", selfPrinting: true });
  expect(window.open).toHaveBeenCalled();
  expect(popupWindow.onload).toBeNull();
});

it("other pages are printed by the opener on load, as before", () => {
  const popupWindow = openPopup();
  print_html({ src: "/p/files/a.pdf" });
  expect(typeof popupWindow.onload).toBe("function");
  popupWindow.onload();
  expect(popupWindow.print).toHaveBeenCalled();
});
