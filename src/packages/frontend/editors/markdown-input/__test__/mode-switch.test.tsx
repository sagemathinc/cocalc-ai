/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkdownInputModeSwitch } from "../mode-switch";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({}) },
}));
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));

it("opens formatting independently of mode and restores keyboard focus on Escape", async () => {
  const user = userEvent.setup();
  const onSelectMode = jest.fn();
  render(
    <MarkdownInputModeSwitch
      mode="editor"
      isFocusedFrame
      isVisible
      editBarContentRef={{ current: <button>Bold</button> }}
      onSelectMode={onSelectMode}
      onInteractionStart={() => {}}
      onInteractionEnd={() => {}}
    />,
  );
  expect(screen.getAllByRole("radio")).toHaveLength(2);
  const trigger = screen.getByRole("button", { name: "Text formatting" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Text formatting" });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(onSelectMode).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close formatting" }),
    ),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(trigger.getAttribute("aria-expanded")).toBe("false"),
  );
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  await user.click(
    await screen.findByRole("button", { name: "Close formatting" }),
  );
  expect(document.activeElement).toBe(trigger);
  screen.getByRole("radio", { name: "Markdown" }).focus();
  await user.keyboard(" ");
  expect(onSelectMode).toHaveBeenCalledWith("markdown");
});
