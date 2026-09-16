/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CloudflareSettingsEntry, {
  showSettingsSubgroup,
} from "./cloudflare-settings-entry";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));

it("puts keyboard-accessible setup before rotation help", async () => {
  const user = userEvent.setup();
  const configure = jest.fn();
  render(<CloudflareSettingsEntry onConfigure={configure} />);
  const setup = screen.getByRole("button", { name: "Configure Cloudflare" });
  expect(screen.getAllByRole("button")[0]).toBe(setup);
  await user.tab();
  expect(setup).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(configure).toHaveBeenCalledTimes(1);
  await user.tab();
  expect(
    screen.getByRole("button", {
      name: "How to rotate Cloudflare credentials",
    }),
  ).toHaveFocus();
});

it("provides an R2 setup action instead of an empty header", async () => {
  const user = userEvent.setup();
  const configure = jest.fn();
  render(<CloudflareSettingsEntry storageOnly onConfigure={configure} />);
  await user.click(
    screen.getByRole("button", { name: "Configure R2 storage" }),
  );
  expect(configure).toHaveBeenCalledTimes(1);
  expect(
    screen.getByText(/Individual fields are available with Show hidden/),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /rotate/ })).toBeNull();
});

it("removes empty header-only disclosures but retains useful controls and R2 setup", () => {
  const header = { name: "heading", conf: { type: "header" } };
  const field = { name: "field", conf: {} };
  expect(
    showSettingsSubgroup("Backups & Storage", "Empty", [header], false),
  ).toBe(false);
  expect(
    showSettingsSubgroup("Backups & Storage", "Cloudflare R2", [header], false),
  ).toBe(true);
  expect(
    showSettingsSubgroup(
      "Backups & Storage",
      "Settings",
      [header, field],
      false,
    ),
  ).toBe(true);
  expect(
    showSettingsSubgroup(
      "Cloudflare",
      "Mode",
      [{ name: "cloudflare_mode", conf: {} }],
      false,
    ),
  ).toBe(false);
  expect(
    showSettingsSubgroup(
      "Cloudflare",
      "Mode",
      [{ name: "cloudflare_mode", conf: {} }],
      true,
    ),
  ).toBe(true);
  expect(showSettingsSubgroup("Cloudflare", "Mode", [field], false)).toBe(true);
});
