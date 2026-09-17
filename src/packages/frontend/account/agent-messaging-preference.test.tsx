import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentMessagingPreference } from "./agent-messaging-preference";

const mockSave = jest.fn();
let mockEnabled = false;
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ set_other_settings_and_wait: mockSave }) },
}));
jest.mock("@cocalc/frontend/agents/use-ui-preference", () => ({
  useAgentMessagingUI: () => mockEnabled,
}));

beforeEach(() => {
  mockEnabled = false;
  mockSave.mockReset().mockResolvedValue(undefined);
});

test("default off is keyboard accessible and does not write a preference on mount", async () => {
  const user = userEvent.setup();
  render(<AgentMessagingPreference />);
  const toggle = screen.getByRole("switch", {
    name: "Enable experimental agent messaging",
  });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(mockSave).not.toHaveBeenCalled();
  expect(
    screen.getByRole("link", { name: /Inspect, pause or revoke/ }),
  ).toHaveAttribute("href", "/settings/my-agents");
  await user.tab();
  expect(toggle).toHaveFocus();
  await user.keyboard(" ");
  await waitFor(() =>
    expect(mockSave).toHaveBeenCalledWith("experimental_agent_messaging", true),
  );
});

test("failed persistence is announced without pretending the preference changed", async () => {
  mockSave.mockRejectedValue(new Error("offline"));
  const user = userEvent.setup();
  render(<AgentMessagingPreference />);
  await user.click(screen.getByRole("switch"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to save");
  expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
});

test("disabling only writes the UI preference and keeps management accessible", async () => {
  mockEnabled = true;
  const user = userEvent.setup();
  render(<AgentMessagingPreference />);
  await user.click(screen.getByRole("switch"));
  await waitFor(() =>
    expect(mockSave).toHaveBeenCalledWith(
      "experimental_agent_messaging",
      false,
    ),
  );
  expect(
    screen.getByRole("link", { name: /Inspect, pause or revoke/ }),
  ).toBeVisible();
  expect(
    screen.getByText(/does not pause communication or revoke/),
  ).toBeVisible();
});
