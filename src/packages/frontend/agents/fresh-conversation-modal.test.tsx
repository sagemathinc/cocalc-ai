import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FreshConversationModal } from "./fresh-conversation-modal";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

const getIdentity = jest.fn();
jest.mock("./api", () => ({ personalAgentApi: () => ({ getIdentity }) }));
jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/",
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => undefined },
}));

test("keyboard confirmation keeps errors visible and permits an explicit retry", async () => {
  const user = userEvent.setup();
  const onConfirm = jest
    .fn()
    .mockRejectedValueOnce(new Error("Finish queued work"))
    .mockResolvedValue(undefined);
  const onClose = jest.fn();
  render(
    <FreshConversationModal
      name="helper"
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
  expect(
    screen.getByRole("dialog", {
      name: "Start a fresh conversation with @helper?",
    }),
  ).toBeTruthy();
  const button = screen.getByRole("button", {
    name: "Start fresh conversation",
  });
  button.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Finish queued work",
    ),
  );
  expect(onClose).not.toHaveBeenCalled();
  button.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onConfirm).toHaveBeenCalledTimes(2);
});

test("Escape cancels without creating a conversation", async () => {
  const user = userEvent.setup();
  const onConfirm = jest.fn(),
    onClose = jest.fn();
  render(
    <FreshConversationModal
      name="helper"
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
  screen.getByRole("button", { name: "Cancel" }).focus();
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

test("past conversations expose keyboard-focusable project thread links without resetting", async () => {
  const user = userEvent.setup();
  getIdentity.mockResolvedValue({
    conversation_history: [
      { thread_id: "old & one", ended_at: "2026-09-21T05:00:00Z" },
      { thread_id: "old-two", ended_at: "2026-09-21T06:00:00Z" },
    ],
  });
  const onConfirm = jest.fn();
  render(
    <FreshConversationModal
      name="helper"
      agent={
        {
          name: "helper",
          endpoint: { project_id: "project", agent_id: "agent" },
          path: "/a space.chat",
        } as NamedAgent
      }
      onConfirm={onConfirm}
      onClose={jest.fn()}
    />,
  );
  const links = await screen.findAllByRole("link", { name: /helper · ended/ });
  expect(links[0].getAttribute("href")).toContain(
    "/projects/project/files/a%20space.chat#thread=old-two",
  );
  expect(links[1].getAttribute("href")).toContain("#thread=old%20%26%20one");
  links[0].focus();
  await user.tab();
  expect(document.activeElement).toBe(links[1]);
  expect(onConfirm).not.toHaveBeenCalled();
  expect(screen.getByText(/Return to this modal/)).toBeTruthy();
  expect(screen.getByText("Name agent")).toBeTruthy();
});
