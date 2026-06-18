/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { UseBalance, UseTeamLicenseBalance } from "../balance-toward-subs";

let storedSettings: Record<string, boolean | undefined>;
const setOtherSettings = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({
      set_other_settings: setOtherSettings,
    }),
  },
  useTypedRedux: () => ({
    get: (key: string) => storedSettings[key],
  }),
}));

jest.mock("@cocalc/util/db-schema/accounts", () => ({
  USE_BALANCE_TOWARD_SUBSCRIPTIONS: "use_balance_toward_subscriptions",
  USE_BALANCE_TOWARD_SUBSCRIPTIONS_DEFAULT: true,
  USE_BALANCE_TOWARD_TEAM_LICENSES: "use_balance_toward_team_licenses",
  USE_BALANCE_TOWARD_TEAM_LICENSES_DEFAULT: true,
}));

jest.mock("antd", () => {
  const Div = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Flex: Div,
    Space: Div,
    Switch: ({
      checked,
      onChange,
    }: {
      checked: boolean;
      onChange: (value: boolean) => void;
    }) => (
      <input
        aria-label="Use account balance for renewals"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
    ),
    Typography: {
      Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    },
  };
});

describe("UseBalance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storedSettings = {};
  });

  it("defaults to using account balance for membership renewals", () => {
    render(<UseBalance />);

    expect(
      screen.getByLabelText("Use account balance for renewals"),
    ).toBeChecked();
    expect(
      screen.getByText(
        "Renewals use your account balance only when it covers the full renewal amount; otherwise CoCalc charges your payment method in full.",
      ),
    ).toBeTruthy();
  });

  it("renders the stored preference and updates it through account actions", () => {
    storedSettings.use_balance_toward_subscriptions = false;
    render(<UseBalance />);

    const switchInput = screen.getByLabelText(
      "Use account balance for renewals",
    );
    expect(switchInput).not.toBeChecked();
    expect(
      screen.getByText("Renewals charge your payment method."),
    ).toBeTruthy();

    fireEvent.click(switchInput);

    expect(setOtherSettings).toHaveBeenCalledWith(
      "use_balance_toward_subscriptions",
      true,
    );
  });

  it("can control team-license renewals independently", () => {
    storedSettings.use_balance_toward_subscriptions = false;
    storedSettings.use_balance_toward_team_licenses = true;
    render(<UseTeamLicenseBalance />);

    const switchInput = screen.getByLabelText(
      "Use account balance for renewals",
    );
    expect(switchInput).toBeChecked();

    fireEvent.click(switchInput);

    expect(setOtherSettings).toHaveBeenCalledWith(
      "use_balance_toward_team_licenses",
      false,
    );
  });
});
