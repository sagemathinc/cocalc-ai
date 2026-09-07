/** @jest-environment jsdom */

/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { render } from "@testing-library/react";
import { CodeMirrorStatic } from "./codemirror-static";

jest.mock("@cocalc/frontend/codemirror/static", () => ({
  __esModule: true,
  default: { runMode: (value, _mode, append) => append(value) },
}));
jest.mock("@cocalc/frontend/components/code-editor", () => () => null);

test("default cells do not leak their white background into Follow or named themes", () => {
  const { container, rerender } = render(
    <CodeMirrorStatic value="1 + 1" options={{ theme: "default" }} />,
  );
  const editor = container.querySelector<HTMLElement>(".CodeMirror")!;
  expect(editor.style.background).toBe("white");
  for (const theme of ["cocalc-dark", "monokai", "cocalc-light"]) {
    rerender(<CodeMirrorStatic value="1 + 1" options={{ theme }} />);
    expect(container.querySelector(".CodeMirror")).toBe(editor);
    expect(editor.style.background).toBe("");
    expect(editor).toHaveClass(`cm-s-${theme}`);
  }
});
