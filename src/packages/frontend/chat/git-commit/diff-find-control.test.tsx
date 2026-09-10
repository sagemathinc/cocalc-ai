import { createRef, useState } from "react";
import type { InputRef } from "antd";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitDiffFind } from "./diff-find-control";

test("Find retains keyboard focus, Enter/Shift+Enter navigation, and match counts", async () => {
  const user = userEvent.setup();
  const next = jest.fn(),
    previous = jest.fn();
  const inputRef = createRef<InputRef>();
  function Test() {
    const [query, setQuery] = useState("");
    return (
      <GitDiffFind
        inputRef={inputRef}
        query={query}
        onChange={setQuery}
        onNext={next}
        onPrevious={previous}
        count={query ? 3 : 0}
        index={1}
      />
    );
  }
  render(<Test />);
  expect(
    screen.getByRole("button", { name: "Next diff match" }),
  ).toBeDisabled();
  inputRef.current!.focus();
  const input = screen.getByRole("textbox", { name: "Find in diff" });
  expect(input).toHaveFocus();
  await user.keyboard("needle{Enter}{Shift>}{Enter}{/Shift}");
  expect(input).toHaveFocus();
  expect(next).toHaveBeenCalledTimes(1);
  expect(previous).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("2 / 3");
  await user.click(screen.getByRole("button", { name: "Next diff match" }));
  expect(next).toHaveBeenCalledTimes(2);
});
