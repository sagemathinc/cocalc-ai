import "@testing-library/jest-dom";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VmStopAfter from "./compute-vm-stop-after";

it("defaults to six hours and supports keyboard opt-out and editing", async () => {
  const user = userEvent.setup();
  const onChange = jest.fn();
  function Form() {
    const [value, setValue] = useState<number | null | undefined>();
    return (
      <VmStopAfter
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Form />);
  const checkbox = screen.getByRole("checkbox", { name: "Stop after" });
  const hours = screen.getByRole("spinbutton", { name: "Stop after hours" });
  expect(checkbox).toBeChecked();
  expect(hours).toHaveValue("6");
  await user.tab();
  expect(checkbox).toHaveFocus();
  await user.keyboard(" ");
  expect(checkbox).not.toBeChecked();
  expect(hours).toBeDisabled();
  expect(onChange).toHaveBeenLastCalledWith(null);
  await user.keyboard(" ");
  await user.tab();
  expect(hours).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(onChange).toHaveBeenLastCalledWith(420);
});

it("keeps an explicit disabled choice instead of defaulting it back on", () => {
  render(<VmStopAfter value={null} />);
  expect(
    screen.getByRole("checkbox", { name: "Stop after" }),
  ).not.toBeChecked();
});
