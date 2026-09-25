import { act, render, screen } from "@testing-library/react";
import { PreparationStatus } from "./preparation-status";

afterEach(() => jest.useRealTimers());

it("announces real stages immediately without moving keyboard focus", () => {
  const { rerender } = render(
    <>
      <input aria-label="Prompt" />
      <PreparationStatus active={false} phase="workspace" />
    </>,
  );
  screen.getByRole("textbox", { name: "Prompt" }).focus();
  rerender(
    <>
      <input aria-label="Prompt" />
      <PreparationStatus active phase="identity" />
    </>,
  );
  expect(screen.getByRole("status").textContent).toBe(
    "Preparing your agent...",
  );
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Prompt" }),
  );
  rerender(
    <>
      <input aria-label="Prompt" />
      <PreparationStatus active phase="sending" />
    </>,
  );
  expect(screen.getByRole("status").textContent).toBe(
    "Sending your request...",
  );
});

it("does not leave a long wait as just a spinner", () => {
  jest.useFakeTimers();
  render(<PreparationStatus active phase="starting" />);
  act(() => jest.advanceTimersByTime(60_000));
  expect(screen.getByText(/delay is being recorded/)).toBeTruthy();
});
