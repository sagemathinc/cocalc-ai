/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewAgentRuntimeSelect } from "./new-agent-runtime-select";

test("runtime selector opens full labels from the keyboard", async () => {
  const user = userEvent.setup();
  const onChange = jest.fn();
  render(<NewAgentRuntimeSelect value="codex-native" onChange={onChange} />);
  await user.tab();
  const picker = screen.getByRole("combobox", { name: "Agent runtime" });
  expect(document.activeElement).toBe(picker);
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("option", { name: "Claude" })).toBeTruthy();
  expect(
    screen.getByRole("option", {
      name: "Custom ACP harness (experimental)",
    }),
  ).toBeTruthy();
  expect(document.activeElement).toBe(picker);
  await user.click(screen.getByRole("option", { name: "Claude" }));
  expect(onChange).toHaveBeenCalledWith("claude-code", expect.anything());
});

test("the first-run selector offers only Codex and Claude", async () => {
  const user = userEvent.setup();
  render(
    <NewAgentRuntimeSelect
      value="codex-native"
      includeCustom={false}
      onChange={jest.fn()}
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "Agent runtime" }));
  expect(await screen.findByRole("option", { name: "Claude" })).toBeTruthy();
  expect(
    screen.queryByRole("option", {
      name: "Custom ACP harness (experimental)",
    }),
  ).toBeNull();
});
