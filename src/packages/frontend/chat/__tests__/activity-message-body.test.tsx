/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityMessageBody } from "../activity-message-body";
import { AgentLaunchStatus } from "../agent-launch-status";

it("keeps full message text keyboard accessible without covering queue controls", async () => {
  const user = userEvent.setup();
  const cancel = jest.fn();
  const view = render(
    <>
      <ActivityMessageBody compact>
        <div>Full original response and source</div>
      </ActivityMessageBody>
      <button onClick={cancel}>Cancel queued message</button>
    </>,
  );
  expect(
    screen.queryByText("Full original response and source"),
  ).not.toBeInTheDocument();
  await user.tab();
  const show = screen.getByRole("button", { name: "Show full message" });
  expect(show).toHaveFocus();
  expect(show).toHaveAttribute("aria-expanded", "false");
  await user.keyboard("{Enter}");
  expect(screen.getByText("Full original response and source")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Hide full message" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Cancel queued message" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(cancel).toHaveBeenCalledTimes(1);
  view.rerender(
    <ActivityMessageBody compact={false}>
      <div>Full original response and source</div>
    </ActivityMessageBody>,
  );
  expect(screen.getByText("Full original response and source")).toBeVisible();
});

it("does not hide an unconfirmed launch or its keyboard recovery action", async () => {
  const user = userEvent.setup();
  const resubmit = jest.fn(async () => true);
  render(
    <>
      <ActivityMessageBody compact>
        <div>Long saved network message</div>
      </ActivityMessageBody>
      <AgentLaunchStatus
        receipt={{ state: "unknown", updated_at: 1 }}
        onResubmit={resubmit}
      />
    </>,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "agent launch not confirmed",
  );
  await user.tab();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Resubmit to Agent" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(resubmit).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("Submission confirmed");
});
