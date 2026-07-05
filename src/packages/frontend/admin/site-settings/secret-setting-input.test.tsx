/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import SecretSettingInput from "./secret-setting-input";

describe("SecretSettingInput", () => {
  it("shows a stored-secret placeholder and note when a saved value exists", () => {
    render(<SecretSettingInput value="" onChange={() => {}} isSet />);

    expect(
      screen.getByPlaceholderText("Stored (enter to replace)"),
    ).toBeTruthy();
    expect(
      screen.getByText("Saved. Leave blank to keep the current value."),
    ).toBeTruthy();
  });

  it("calls onClear from the stored-secret note", () => {
    const onClear = jest.fn();
    render(
      <SecretSettingInput
        value=""
        onChange={() => {}}
        isSet
        onClear={onClear}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("passes edited values through onChange", () => {
    const onChange = jest.fn();
    render(
      <SecretSettingInput
        value=""
        placeholder="API token"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("API token"), {
      target: { value: "new-secret" },
    });

    expect(onChange).toHaveBeenCalledWith("new-secret");
  });
});
