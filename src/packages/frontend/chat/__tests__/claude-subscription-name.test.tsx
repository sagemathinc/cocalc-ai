/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClaudeSubscriptionName } from "../claude-subscription-name";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: ({ date }: { date: string }) => <span>at {date}</span>,
}));
jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: () => <span />,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: { system: { updateClaudeSubscriptionLabel: jest.fn() } },
    },
  },
}));
const rename = jest.mocked(
  webapp_client.conat_client.hub.system.updateClaudeSubscriptionLabel,
);
const credential = {
  id: "00000000-0000-4000-8000-000000000001",
  metadata: { expires_at: "2027-10-02T00:00:00.000Z" },
} as any;

beforeEach(() => jest.clearAllMocks());

test("names a subscription in place and shows when its token expires", async () => {
  rename.mockResolvedValue({ updated: true });
  const onRenamed = jest.fn();
  render(
    <ClaudeSubscriptionName credential={credential} onRenamed={onRenamed} />,
  );
  expect(screen.getByText(/Long-lived token, expires/)).toBeTruthy();
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: /Name this subscription/ }),
  );
  await user.type(screen.getByLabelText("Subscription name"), "Max 20x{Enter}");
  await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("Max 20x"));
  expect(rename).toHaveBeenCalledTimes(1);
  expect(rename).toHaveBeenCalledWith({ id: credential.id, label: "Max 20x" });
  expect(screen.queryByLabelText("Subscription name")).toBeNull();
});

test("Escape cancels without saving; failures are shown", async () => {
  const onRenamed = jest.fn();
  render(
    <ClaudeSubscriptionName
      credential={{ ...credential, metadata: { label: "Old" } }}
      onRenamed={onRenamed}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Rename/ }));
  await user.type(screen.getByLabelText("Subscription name"), "x{Escape}");
  expect(rename).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Subscription name")).toBeNull();

  rename.mockResolvedValue({ updated: false });
  await user.click(screen.getByRole("button", { name: /Rename/ }));
  await user.type(screen.getByLabelText("Subscription name"), "New{Enter}");
  expect(
    await screen.findByText("This subscription is no longer connected."),
  ).toBeTruthy();
  expect(onRenamed).not.toHaveBeenCalled();
});
