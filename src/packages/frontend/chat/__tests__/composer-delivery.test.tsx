/** @jest-environment jsdom */
import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  ComposerDeliverySelector,
  type ComposerDelivery,
} from "../composer-delivery";

jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));

it("offers explicit delivery actions and restores trigger focus on Escape", async () => {
  function Harness() {
    const [value, setValue] = useState<ComposerDelivery>("agent");
    return <ComposerDeliverySelector value={value} onChange={setValue} />;
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", {
    name: "Message delivery: To Agent",
  });
  expect(trigger).toHaveStyle({ color: "var(--cocalc-ui-secondary)" });
  trigger.focus();
  fireEvent.click(trigger);
  const post = await screen.findByRole("menuitem", {
    name: /Post Ctrl\+Enter/,
  });
  act(() => post.focus());
  fireEvent.keyDown(post, { key: "Enter", keyCode: 13 });
  expect(
    screen.getByRole("button", { name: "Message delivery: Post" }),
  ).toBeTruthy();
  fireEvent.click(trigger);
  const menu = await screen.findByRole("menu");
  fireEvent.keyDown(menu, { key: "Escape", keyCode: 27 });
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
