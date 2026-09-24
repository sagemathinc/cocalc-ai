import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentProjectSelector } from "./agent-project-selector";

jest.mock("@cocalc/frontend/projects/select-project", () => ({
  SelectProject: ({ ariaLabel, value, disabled, onChange }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="project-1">Existing project</option>
    </select>
  ),
}));

it("opens project creation from a keyboard-accessible control", async () => {
  const onCreate = jest.fn();
  render(
    <AgentProjectSelector
      value="project-1"
      disabled={false}
      onChange={jest.fn()}
      onCreate={onCreate}
    />,
  );

  expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(
    "project-1",
  );
  const create = screen.getByRole("button", { name: "Create project" });
  create.focus();
  expect(create).toHaveFocus();
  await userEvent.setup().keyboard("{Enter}");
  expect(onCreate).toHaveBeenCalledTimes(1);
});

it("does not allow creating a project while agent creation is busy", () => {
  render(
    <AgentProjectSelector disabled onChange={jest.fn()} onCreate={jest.fn()} />,
  );

  expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Project" })).toBeDisabled();
});
