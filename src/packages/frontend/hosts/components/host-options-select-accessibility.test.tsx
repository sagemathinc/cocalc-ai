import { Form } from "antd";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostOptionsSelect } from "./host-options-select";

it("connects the form label and help to a keyboard-operable selector", async () => {
  const user = userEvent.setup();
  const onChange = jest.fn();
  render(
    <Form name="funding-vm">
      <Form.Item name="region" label="Region">
        <HostOptionsSelect
          aria-describedby="region-help"
          options={[{ value: "us-central1", label: "Iowa" }]}
          onChange={onChange}
        />
      </Form.Item>
      <p id="region-help">VM location</p>
    </Form>,
  );
  const region = screen.getByRole("combobox", { name: "Region" });
  expect(region).toHaveAccessibleDescription("VM location");
  await user.tab();
  expect(region).toHaveFocus();
  fireEvent.keyDown(region, { key: "ArrowDown", keyCode: 40, which: 40 });
  await screen.findByRole("option", { name: "Iowa" });
  fireEvent.keyDown(region, { key: "Enter", keyCode: 13, which: 13 });
  await waitFor(() => expect(onChange.mock.calls[0]?.[0]).toBe("us-central1"));
});
