/** @jest-environment jsdom */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CloudflareCredentialRotationHelp from "./cloudflare-credential-rotation-help";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));

describe("Cloudflare credential rotation guide", () => {
  const originalGetComputedStyle = window.getComputedStyle;
  beforeAll(() => {
    jest
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element) => originalGetComputedStyle(element));
  });
  afterAll(() => jest.restoreAllMocks());

  it("opens by keyboard, contains focus, and restores focus after Escape", async () => {
    const user = userEvent.setup();
    render(<CloudflareCredentialRotationHelp />);
    const trigger = screen.getByRole("button", {
      name: "How to rotate Cloudflare credentials",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", {
      name: "How to rotate Cloudflare credentials",
    });
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("distinguishes admin-only replacement from emergency S3 recovery", async () => {
    const user = userEvent.setup();
    render(<CloudflareCredentialRotationHelp />);
    await user.click(
      screen.getByRole("button", {
        name: "How to rotate Cloudflare credentials",
      }),
    );
    const planned = screen.getByRole("region", {
      name: "Orderly planned rotation",
    });
    expect(planned).toHaveTextContent("This does not rotate the R2 S3 keys");
    expect(planned).toHaveTextContent("do not delete");
    expect(planned).toHaveTextContent(
      "Waiting is observation time, not proof of safety",
    );
    const emergency = screen.getByRole("region", {
      name: "Emergency rotation",
    });
    expect(emergency).toHaveTextContent(
      "Bootstrap alone does not replace an existing, revoked S3 pair",
    );
    expect(emergency).toHaveTextContent("r2_access_key_id");
    expect(emergency).toHaveTextContent("r2_secret_access_key");
    expect(emergency).toHaveTextContent(
      "Confirm the replacement settings reached every bay",
    );
    expect(emergency).toHaveTextContent(
      "rebooting refreshes managed project-backup keys on the next operation",
    );
    expect(emergency).toHaveTextContent(
      "Host reboot does not update static rustic TOML files",
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).getAllByRole("button")).toHaveLength(2);
    await user.click(
      within(dialog).getByRole("button", { name: "Close guide" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen.getByRole("button", {
        name: "How to rotate Cloudflare credentials",
      }),
    ).toHaveFocus();
  });
});
