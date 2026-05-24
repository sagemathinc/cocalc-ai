/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { PasswordSetting } from "./password-setting";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_client: {
      change_password: jest.fn(),
    },
  },
}));

describe("PasswordSetting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("wraps password changes in the fresh-auth action runner", async () => {
    const changePassword = jest.mocked(
      webapp_client.account_client.change_password,
    );
    const runFreshAuthAction = jest.fn(async (action: () => Promise<void>) => {
      await action();
      return true;
    });
    changePassword.mockResolvedValueOnce(undefined);

    render(
      <IntlProvider locale="en">
        <PasswordSetting runFreshAuthAction={runFreshAuthAction} />
      </IntlProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /change password/i }));
    fireEvent.change(screen.getByPlaceholderText("Current password"), {
      target: { value: "old-password" },
    });
    fireEvent.change(screen.getByPlaceholderText("New password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^change password$/i }));

    await waitFor(() => {
      expect(runFreshAuthAction).toHaveBeenCalledTimes(1);
      expect(changePassword).toHaveBeenCalledWith(
        "old-password",
        "correct horse battery staple",
      );
    });
  });
});
