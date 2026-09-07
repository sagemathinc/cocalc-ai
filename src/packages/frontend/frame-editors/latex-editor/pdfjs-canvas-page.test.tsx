/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { render } from "@testing-library/react";
import CanvasPage from "./pdfjs-canvas-page";

jest.mock("./pdfjs-annotation", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("./pdfjs-text", () => ({ __esModule: true, default: () => null }));

test("PDF colors stay original in dark appearance; explicit inversion retains the canvas", () => {
  const context = jest
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({} as any);
  const page = {
    getViewport: () => ({ width: 400, height: 600 }),
    render: jest.fn(() => ({ promise: Promise.resolve() })),
  } as any;
  document.documentElement.dataset.cocalcTheme = "dark";
  try {
    const props = { page, scale: 1, clickAnnotation: jest.fn() };
    const { container, rerender } = render(<CanvasPage {...props} />);
    const canvas = container.querySelector("canvas")!;
    expect(canvas.style.filter).toBe("");
    rerender(<CanvasPage {...props} invertColors />);
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(canvas.style.filter).toBe("invert(1) hue-rotate(180deg)");
    rerender(<CanvasPage {...props} invertColors={false} />);
    expect(canvas.style.filter).toBe("");
    expect(page.render).toHaveBeenCalledTimes(1);
  } finally {
    context.mockRestore();
    delete document.documentElement.dataset.cocalcTheme;
  }
});
