/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";
import { TextDocument } from "./document";

const mockEditor = {
  getScrollInfo: jest.fn(() => ({ top: 0 })),
  getValue: jest.fn(() => "version"),
  getWrapperElement: jest.fn(() => document.createElement("div")),
  off: jest.fn(),
  on: jest.fn(),
  refresh: jest.fn(),
  scrollTo: jest.fn(),
  setValue: jest.fn(),
  setValueNoJump: jest.fn(),
};

jest.mock("codemirror", () => ({
  fromTextArea: () => mockEditor,
}));
jest.mock("jquery", () => ({
  __esModule: true,
  default: () => ({ css: jest.fn(), remove: jest.fn() }),
}));
jest.mock("../generic/codemirror-plugins", () => ({}));
jest.mock("../codemirror/cm-options", () => ({ cm_options: () => ({}) }));
jest.mock("../codemirror/util", () => ({ init_style_hacks: jest.fn() }));

test("restores and saves the CodeMirror viewport position", () => {
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  const scrollPosition = { current: 180 };
  const { unmount } = render(
    <TextDocument
      id="frame-1"
      path="history.py"
      project_id="project-1"
      font_size={14}
      editor_settings={{} as any}
      value="version"
      scrollPosition={scrollPosition}
    />,
  );

  expect(mockEditor.scrollTo).toHaveBeenCalledWith(null, 180);
  const onScroll = mockEditor.on.mock.calls.find(
    ([event]) => event === "scroll",
  )?.[1];
  mockEditor.getScrollInfo.mockReturnValue({ top: 420 });
  act(() => onScroll());
  expect(scrollPosition.current).toBe(420);

  unmount();
  expect(mockEditor.off).toHaveBeenCalledWith("scroll", onScroll);
});
