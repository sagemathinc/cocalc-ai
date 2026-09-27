/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PeerAgentLink } from "./peer-agent-link";

const getIdentity = jest.fn();
const openAgentNotification = jest.fn();
const openAgentThread = jest.fn();
jest.mock("./api", () => ({ personalAgentApi: () => ({ getIdentity }) }));
jest.mock("./open-notification", () => ({
  openAgentNotification: (...args) => openAgentNotification(...args),
}));
jest.mock("./open-agent", () => ({
  openAgentThread: (...args) => openAgentThread(...args),
}));
const target = { project_id: "peer-project", agent_id: "peer-agent" };
const identity = { ...target, path: "other.chat", thread_id: "peer-thread" };
beforeEach(() => {
  jest.clearAllMocks();
  getIdentity.mockResolvedValue(identity);
  openAgentNotification.mockResolvedValue(false);
});

it("opens the exact peer with the keyboard, falling back to its project thread", async () => {
  const user = userEvent.setup();
  render(
    <PeerAgentLink target={target} label="@reviewer">
      From @reviewer
    </PeerAgentLink>,
  );
  screen.getByRole("button", { name: "Open agent @reviewer" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(openAgentThread).toHaveBeenCalledWith(identity));
  expect(getIdentity).toHaveBeenCalledWith(target);
  expect(openAgentNotification).toHaveBeenCalledWith(
    "peer-project",
    "other.chat",
    "peer-thread",
  );
});

it("stays in the Agents workspace when the peer is registered there", async () => {
  openAgentNotification.mockResolvedValue(true);
  render(
    <PeerAgentLink target={target} label="@reviewer">
      To @reviewer
    </PeerAgentLink>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Open agent @reviewer" }),
  );
  await waitFor(() => expect(openAgentNotification).toHaveBeenCalled());
  expect(openAgentThread).not.toHaveBeenCalled();
});

it("shows lookup failures without guessing another agent or project", async () => {
  getIdentity.mockRejectedValue(new Error("Permission denied"));
  render(
    <PeerAgentLink target={target} label="@reviewer">
      From @reviewer
    </PeerAgentLink>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Open agent @reviewer" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Permission denied",
  );
  expect(openAgentThread).not.toHaveBeenCalled();
});
