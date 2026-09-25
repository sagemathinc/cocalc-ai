import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map } from "immutable";
import { LegacyMigrationCtaBanner } from "./legacy-migration-cta-banner";

let accountId = "account-a";
const settings = new globalThis.Map<string, boolean>();
const setOtherSettings = jest.fn((_key: string, value: boolean) => {
  settings.set(accountId, value);
});
const preview = jest.fn(async () => ({ can_apply: true }));
const projects = jest.fn(async () => ({ projects: [] }));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({ set_other_settings: setOtherSettings }),
  useTypedRedux: (_store: string, field: string) => {
    if (field === "account_id") return accountId;
    if (field === "other_settings") {
      return Map({
        legacy_migration_banner_dismissed: settings.get(accountId),
      });
    }
    return true;
  },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        legacyMigration: {
          previewFinancialMigration: () => preview(),
          listProjects: () => projects(),
        },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: jest.fn(),
}));
jest.mock("@cocalc/frontend/purchases/legacy-billing-migration-review", () => ({
  markLegacyBillingMigrationReviewRequested: jest.fn(),
}));
jest.mock("@cocalc/frontend/misc/local-storage-typed", () => ({
  get: () => undefined,
  set: jest.fn(),
}));

beforeEach(() => {
  accountId = "account-a";
  settings.clear();
  jest.clearAllMocks();
});

it("saves permanent dismissal using the keyboard and retains it on remount", async () => {
  const user = userEvent.setup();
  const view = render(<LegacyMigrationCtaBanner />);
  const button = await screen.findByRole("button", {
    name: "Don't show again",
  });
  button.focus();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(setOtherSettings).toHaveBeenCalledWith(
    "legacy_migration_banner_dismissed",
    true,
  );
  view.rerender(<LegacyMigrationCtaBanner />);
  expect(screen.queryByRole("button", { name: "Don't show again" })).toBeNull();
  view.unmount();
  preview.mockClear();
  const remount = render(<LegacyMigrationCtaBanner />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(preview).not.toHaveBeenCalled();
  remount.unmount();
});

it("does not apply one account's permanent dismissal to another account", async () => {
  settings.set("account-a", true);
  const view = render(<LegacyMigrationCtaBanner />);
  expect(screen.queryByRole("alert")).toBeNull();
  accountId = "account-b";
  view.rerender(<LegacyMigrationCtaBanner />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Don't show again" }),
    ).toBeVisible(),
  );
  expect(
    screen.getByRole("button", { name: "Review billing migration" }),
  ).toBeVisible();
  view.unmount();
});
