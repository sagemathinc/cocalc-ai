/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { UseBalance } from "../balance-toward-subs";

let storedSetting: boolean | undefined;
const setOtherSettings = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({
      set_other_settings: setOtherSettings,
    }),
  },
  useTypedRedux: () => ({
    get: (key: string) =>
      key === "use_balance_toward_subscriptions" ? storedSetting : undefined,
  }),
}));

jest.mock("@cocalc/util/db-schema/accounts", () => ({
  USE_BALANCE_TOWARD_SUBSCRIPTIONS_DEFAULT: true,
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
    storedSetting = undefined;
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
    storedSetting = false;
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
});
