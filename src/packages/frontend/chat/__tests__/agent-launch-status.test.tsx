/** @jest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import { AgentLaunchStatus } from "../agent-launch-status";

jest.mock("@cocalc/frontend/account/codex-credentials-panel", () => ({
  CodexCredentialsPanel: ({
    defaultProjectId,
  }: {
    defaultProjectId?: string;
  }) => <div>credentials panel for {defaultProjectId}</div>,
}));

it("normalizes immutable receipts and permits an explicit keyboard resubmit only", async () => {
  const onResubmit = jest.fn(async () => false);
  render(
    <AgentLaunchStatus
      receipt={fromJS({ state: "unknown", updated_at: 1 }) as any}
      onResubmit={onResubmit}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "launch not confirmed",
  );
  expect(onResubmit).not.toHaveBeenCalled();
  screen.getByRole("button", { name: "Resubmit to Agent" }).focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "Submission not confirmed.",
    ),
  );
  expect(onResubmit).toHaveBeenCalledTimes(1);
});

it("does not offer resubmission to a read-only viewer", () => {
  render(<AgentLaunchStatus receipt={{ state: "rejected", updated_at: 1 }} />);
  expect(screen.queryByRole("button")).toBeNull();
});

it.each(["queue", "running", "done"])(
  "suppresses a stale receipt when the job is %s",
  (acpState) => {
    render(
      <AgentLaunchStatus
        receipt={{ state: "unknown", updated_at: 1 }}
        acpState={acpState}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  },
);

it("turns an abandoned pending receipt into an unconfirmed notice, without retrying", () => {
  jest.useFakeTimers();
  const onResubmit = jest.fn();
  render(
    <AgentLaunchStatus
      receipt={{ state: "pending", updated_at: Date.now() }}
      onResubmit={onResubmit}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  act(() => jest.advanceTimersByTime(30_000));
  expect(
    screen.getByRole("button", { name: "Resubmit to Agent" }),
  ).toBeTruthy();
  expect(onResubmit).not.toHaveBeenCalled();
  jest.useRealTimers();
});

it("offers Connect when the agent could not run because nothing pays for it", async () => {
  render(
    <AgentLaunchStatus
      receipt={{
        state: "rejected",
        updated_at: 1,
        error: "Not run",
        needs: "codex-connection",
      }}
      projectId="project-1"
      onResubmit={jest.fn(async () => true)}
    />,
  );
  const status = screen.getByRole("status").textContent;
  expect(status).toContain("needs a ChatGPT plan or API key");
  expect(status).not.toContain("does not prove the turn failed");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(screen.getByText("credentials panel for project-1")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Resubmit to Agent" }),
  ).toBeTruthy();
});
