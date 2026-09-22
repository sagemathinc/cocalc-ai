import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentNameInput, isAgentNameRename } from "./agent-name-input";

function renderInput(
  props: Partial<ComponentProps<typeof AgentNameInput>> = {},
) {
  const onChange = jest.fn();
  const onEnter = jest.fn();
  render(
    <AgentNameInput
      id="agent-name"
      value="builder"
      onChange={onChange}
      onEnter={onEnter}
      {...props}
    />,
  );
  return { onChange, onEnter };
}

test("keeps naming guidance collapsed and omits persistent status copy", async () => {
  const user = userEvent.setup();
  renderInput();

  const requirements = screen.getByRole("button", {
    name: "Agent name requirements",
  });
  expect(requirements).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText(/Use 1-32 letters/)).not.toBeVisible();
  expect(screen.queryByText(/No conflict/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Choose a name/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Old names are retired/)).not.toBeInTheDocument();

  requirements.focus();
  await user.keyboard("{Enter}");
  expect(requirements).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText(/Use 1-32 letters/)).toHaveTextContent(
    "Availability is checked again when saved.",
  );
  expect(screen.queryByText(/Old names are retired/)).not.toBeInTheDocument();

  await user.keyboard(" ");
  expect(requirements).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText(/Use 1-32 letters/)).not.toBeVisible();
});

test("shows and associates the retirement warning only for a pending rename", () => {
  const onChange = jest.fn();
  const { rerender } = render(
    <AgentNameInput
      id="agent-name"
      value="reviewer"
      onChange={onChange}
      showRetirementWarning
    />,
  );

  const input = screen.getByRole("textbox", { name: "Agent name" });
  const warning = screen.getByRole("status");
  expect(warning).toHaveTextContent(
    "The old name will be retired when you save this rename.",
  );
  expect(warning).toBeVisible();
  expect(input).toHaveAttribute("aria-describedby", warning.id);
  expect(screen.getByText(/Use 1-32 letters/)).not.toBeVisible();

  rerender(
    <AgentNameInput id="agent-name" value="builder" onChange={onChange} />,
  );
  expect(
    screen.queryByText(/old name will be retired/i),
  ).not.toBeInTheDocument();
  expect(input).not.toHaveAttribute("aria-describedby");
});

test("classifies only a valid normalized name change as a rename", () => {
  expect(isAgentNameRename("builder", "builder")).toBe(false);
  expect(isAgentNameRename("  BUILDER  ", "builder")).toBe(false);
  expect(isAgentNameRename("reviewer", "builder")).toBe(true);
  expect(isAgentNameRename("invalid name", "builder")).toBe(false);
  expect(isAgentNameRename("builder", undefined)).toBe(false);
});

test("keeps validation errors visible and associated with the input", async () => {
  const user = userEvent.setup();
  renderInput({ problem: "That agent name is already used." });

  const input = screen.getByRole("textbox", { name: "Agent name" });
  const status = screen.getByRole("status");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAttribute("aria-describedby", status.id);

  await user.click(
    screen.getByRole("button", { name: "Agent name requirements" }),
  );
  expect(input.getAttribute("aria-describedby")?.split(" ")).toEqual([
    "agent-name-requirements",
    status.id,
  ]);
});

test("preserves input change, Enter, autofocus, length, and busy behavior", () => {
  const onChange = jest.fn();
  const onEnter = jest.fn();
  const { rerender } = render(
    <AgentNameInput
      id="agent-name"
      value="builder"
      onChange={onChange}
      onEnter={onEnter}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Agent name" });

  expect(input).toHaveFocus();
  expect(input).toHaveAttribute("maxlength", "32");
  fireEvent.change(input, { target: { value: "new-agent" } });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
  expect(onChange).toHaveBeenCalledWith("new-agent");
  expect(onEnter).toHaveBeenCalledTimes(1);

  rerender(
    <AgentNameInput
      id="agent-name"
      value="builder"
      onChange={onChange}
      onEnter={onEnter}
      busy
    />,
  );
  expect(input).toBeDisabled();
});
