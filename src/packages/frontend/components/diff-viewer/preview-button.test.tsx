/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiffPreviewButton } from "./preview-button";

jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }: any) => <div>{children}</div>,
}));
jest.mock("./pierre-preview", () => ({
  __esModule: true,
  default: ({ source }: any) => <div>{source.label}</div>,
}));

it("freezes the opened source and restores keyboard focus on Escape", async () => {
  const user = userEvent.setup();
  const source = {
    kind: "patch" as const,
    patch: "",
    label: "Original revision",
  };
  const { rerender } = render(<DiffPreviewButton getSource={() => source} />);
  const trigger = screen.getByRole("button", { name: "Preview with Pierre" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByText("Original revision")).toBeTruthy();
  rerender(
    <DiffPreviewButton
      getSource={() => ({ ...source, label: "New revision" })}
    />,
  );
  expect(screen.queryByText("New revision")).toBeNull();
  const close = screen.getByRole("button", { name: "Close" });
  close.focus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
