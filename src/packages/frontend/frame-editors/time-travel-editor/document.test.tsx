/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";
import { TextDocument } from "./document";

const mockScroller = document.createElement("div");
const mockEditor = {
  getScrollerElement: jest.fn(() => mockScroller),
  getScrollInfo: jest.fn(() => ({ top: 0 })),
  getValue: jest.fn(() => "version"),
  getWrapperElement: jest.fn(() => document.createElement("div")),
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
  const editorSettings = {} as any;
  const { rerender, unmount } = render(
    <TextDocument
      id="frame-1"
      path="history.py"
      project_id="project-1"
      font_size={14}
      editor_settings={editorSettings}
      value="version"
      scrollPosition={scrollPosition}
    />,
  );

  expect(mockEditor.scrollTo).toHaveBeenCalledWith(null, 180);
  mockEditor.getScrollInfo.mockReturnValue({ top: 420 });
  act(() => mockScroller.dispatchEvent(new WheelEvent("wheel")));
  act(() => mockScroller.dispatchEvent(new Event("scroll")));
  expect(scrollPosition.current).toBe(420);

  mockEditor.getValue.mockReturnValue("version");
  rerender(
    <TextDocument
      id="frame-1"
      path="history.py"
      project_id="project-1"
      font_size={14}
      editor_settings={editorSettings}
      value="next version"
      scrollPosition={scrollPosition}
    />,
  );
  expect(mockEditor.setValueNoJump).toHaveBeenCalledWith("next version");
  expect(mockEditor.scrollTo).toHaveBeenLastCalledWith(null, 420);

  // A collapsing editor reports zero during teardown; that is not a real
  // viewport change and must not overwrite the last scroll event.
  mockEditor.getScrollInfo.mockReturnValue({ top: 0 });
  unmount();
  expect(scrollPosition.current).toBe(420);
});
