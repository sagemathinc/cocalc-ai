/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { Form } from "antd";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodexWorkbenchField } from "../codex-workbench-field";

jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: () => <span aria-hidden="true">?</span>,
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));

describe("Workbench opt-in field", () => {
  it("binds a keyboard-operable checkbox and saves only on form submission", async () => {
    const user = userEvent.setup();
    const onFinish = jest.fn();
    render(
      <Form initialValues={{ workbench: false }} onFinish={onFinish}>
        <CodexWorkbenchField />
        <button type="submit">Save</button>
      </Form>,
    );
    const checkbox = screen.getByRole("checkbox", {
      name: "Workbench (experimental)",
    });
    expect(checkbox).not.toBeChecked();
    await user.tab();
    expect(checkbox).toHaveFocus();
    await user.keyboard(" ");
    expect(checkbox).toBeChecked();
    expect(onFinish).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith({ workbench: true }),
    );
  });

  it("opens help using the keyboard and dismisses it without toggling or losing focus", async () => {
    const user = userEvent.setup();
    render(
      <Form initialValues={{ workbench: false }}>
        <CodexWorkbenchField />
      </Form>,
    );
    await user.tab();
    await user.tab();
    const help = screen.getByRole("button", {
      name: "About Workbench (experimental)",
    });
    expect(help).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(help).toHaveAttribute("aria-expanded", "true");
    await waitFor(() =>
      expect(
        screen.getByText(
          /Off by default\. This setting is saved for this thread/,
        ),
      ).toBeVisible(),
    );
    expect(screen.getByText(/existing cards and workbench tabs/)).toBeVisible();
    await user.keyboard("{Escape}");
    expect(help).toHaveAttribute("aria-expanded", "false");
    expect(help).toHaveFocus();
    expect(
      screen.getByRole("checkbox", { name: "Workbench (experimental)" }),
    ).not.toBeChecked();
  });
});
