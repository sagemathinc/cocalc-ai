import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComputeVm } from "@cocalc/conat/hub/api/compute";
import VmPowerControls from "./compute-vm-power-controls";

const vm = {
  name: "Student VM",
  owner_account_id: "student",
  state: "stopped",
  desired_state: "stopped",
} as ComputeVm;

test.each([false, true])(
  "owner can start by keyboard in accountMode=%s",
  async (accountMode) => {
    const user = userEvent.setup();
    const onStart = jest.fn();
    render(
      <VmPowerControls
        vm={vm}
        accountId="student"
        accountMode={accountMode}
        onStart={onStart}
        onStop={jest.fn()}
      />,
    );
    await user.tab();
    expect(screen.getByRole("button", { name: "Start" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onStart).toHaveBeenCalledTimes(1);
  },
);

test("project owner control requires confirmation to stop", async () => {
  const user = userEvent.setup();
  const onStop = jest.fn();
  render(
    <VmPowerControls
      vm={{ ...vm, state: "ready", desired_state: "running" }}
      accountId="student"
      accountMode={false}
      onStart={jest.fn()}
      onStop={onStop}
    />,
  );
  await user.tab();
  await user.keyboard("{Enter}");
  expect(onStop).not.toHaveBeenCalled();
  const confirm = await screen.findByRole("button", { name: "Stop VM" });
  confirm.focus();
  await user.keyboard("{Enter}");
  expect(onStop).toHaveBeenCalledTimes(1);
});

test("project SSH access alone does not show owner controls", () => {
  render(
    <VmPowerControls
      vm={vm}
      accountId="collaborator"
      accountMode={false}
      onStart={jest.fn()}
      onStop={jest.fn()}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
});
