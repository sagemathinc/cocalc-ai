import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VmShutdownButton from "./compute-vm-shutdown-button";

test("both lines and keyboard activate one shutdown control without a time popover", async () => {
  const user = userEvent.setup();
  const onClick = jest.fn();
  render(
    <VmShutdownButton
      name="Student VM"
      stopAt={new Date(Date.now() + 6 * 3600000).toISOString()}
      onClick={onClick}
    />,
  );
  await user.click(screen.getByText("Auto Shutdown"));
  await user.click(screen.getByText("6 hours from now"));
  const button = screen.getByRole("button", {
    name: "Auto Shutdown: change shutdown timer for Student VM",
  });
  button.focus();
  await user.keyboard("{Enter}");
  expect(onClick).toHaveBeenCalledTimes(3);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByRole("tooltip")).toBeNull();
});
