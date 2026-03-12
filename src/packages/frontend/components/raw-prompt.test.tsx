/** @jest-environment jsdom */

import { act, render } from "@testing-library/react";
import { RawPrompt } from "./raw-prompt";

jest.useFakeTimers();

jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }) => <div data-testid="markdown">{value}</div>,
}));

describe("RawPrompt", () => {
  afterEach(() => {
    jest.clearAllTimers();
  });

  it("keeps scrollBottom working for markdown-rendered string input", () => {
    const rendered = render(<RawPrompt input={"first"} scrollBottom />);
    const scroller = rendered.container.firstElementChild as HTMLDivElement;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 140,
    });
    scroller.scrollTop = 0;

    rendered.rerender(<RawPrompt input={"second"} scrollBottom />);
    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(scroller.scrollTop).toBe(140);
  });
});
