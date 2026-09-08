import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorktreeAgentConsent } from "./worktree-agent-consent";
test("requires explicit keyboard opt-in and cannot toggle during submission", async () => {
  const user = userEvent.setup();
  const onChange = jest.fn();
  const { rerender } = render(
    <WorktreeAgentConsent
      path="/selected worktree"
      checked={false}
      disabled={false}
      onChange={onChange}
    />,
  );
  const checkbox = screen.getByRole("checkbox", {
    name: /Send agent feedback in \/selected worktree/,
  });
  expect(checkbox).not.toBeChecked();
  checkbox.focus();
  await user.keyboard(" ");
  expect(onChange).toHaveBeenCalledWith(true);
  expect(checkbox).toHaveFocus();
  rerender(
    <WorktreeAgentConsent
      path="/selected worktree"
      checked
      disabled
      onChange={onChange}
    />,
  );
  expect(checkbox).toBeChecked();
  expect(checkbox).toBeDisabled();
  await user.keyboard(" ");
  expect(onChange).toHaveBeenCalledTimes(1);
});
