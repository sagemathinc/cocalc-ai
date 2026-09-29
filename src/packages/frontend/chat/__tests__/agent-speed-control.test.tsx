/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Form } from "antd";
import { AgentSpeedControl } from "../agent-speed-control";

test("shared speed control supports keyboard selection and Codex form binding", async () => {
  const onValuesChange = jest.fn();
  render(
    <Form
      initialValues={{ serviceTier: "standard" }}
      onValuesChange={onValuesChange}
    >
      <Form.Item name="serviceTier" label="Speed">
        <AgentSpeedControl />
      </Form.Item>
    </Form>,
  );
  const user = userEvent.setup();
  await user.tab();
  expect(screen.getByRole("radio", { name: "Standard" })).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("radio", { name: "Fast" })).toBeChecked();
  expect(onValuesChange).toHaveBeenLastCalledWith(
    { serviceTier: "fast" },
    { serviceTier: "fast" },
  );
});

test("unavailable fast mode stays disabled", () => {
  render(<AgentSpeedControl value="standard" fastModeSupported={false} />);
  expect(screen.getByRole("radio", { name: "Fast" })).toBeDisabled();
});
