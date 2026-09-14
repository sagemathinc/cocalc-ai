import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodexThreadId } from "../codex-thread-id";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";

jest.mock("@cocalc/frontend/components/copy-to-clipboard-util", () => ({
  copyTextToClipboard: jest.fn(async () => true),
}));

test("thread ID is read-only, keyboard-selectable and copyable without submitting settings", async () => {
  const user = userEvent.setup();
  const submit = jest.fn((event) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <CodexThreadId threadId="thread-123" />
    </form>,
  );
  const input = screen.getByRole("textbox", {
    name: "Thread ID",
  }) as HTMLInputElement;
  expect(input.readOnly).toBe(true);
  expect(input.value).toBe("thread-123");
  await user.tab();
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe("thread-123".length);
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Copy thread ID" }),
  );
  await user.keyboard("{Enter}");
  expect(copyTextToClipboard).toHaveBeenCalledWith({
    text: "thread-123",
    markdown: false,
  });
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Copied" })).toBe(
    document.activeElement,
  );
});

test("does not invent an ID when editing account defaults rather than a thread", () => {
  render(<CodexThreadId />);
  expect(screen.queryByRole("textbox", { name: "Thread ID" })).toBeNull();
});
