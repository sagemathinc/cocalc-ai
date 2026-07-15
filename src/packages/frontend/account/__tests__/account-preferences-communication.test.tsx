/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AccountPreferencesCommunication } from "../account-preferences-communication";
import {
  OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
  type NotificationEmailMode,
} from "@cocalc/util/notification-preferences";

const useTypedRedux = jest.fn();
const setOtherSettings = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({
      set_other_settings: (...args: unknown[]) => setOtherSettings(...args),
    }),
  },
  useTypedRedux: (...args: unknown[]) => useTypedRedux(...args),
}));

jest.mock("react-intl", () => ({
  defineMessage: (message: unknown) => message,
  FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) => (
    <span>{defaultMessage}</span>
  ),
  useIntl: () => ({
    formatMessage: (message: { defaultMessage?: string }) =>
      message.defaultMessage ?? "Communication",
  }),
}));

jest.mock("antd", () => ({
  Alert: ({ message }: { message: ReactNode }) => <div>{message}</div>,
  Button: ({ children, icon, onClick }: any) => (
    <button onClick={onClick} type="button">
      {icon}
      {children}
    </button>
  ),
  Card: ({ children, title }: { children: ReactNode; title: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  Radio: {
    Group: ({
      options,
      onChange,
    }: {
      options: {
        disabled?: boolean;
        value: NotificationEmailMode;
        label: string;
      }[];
      onChange: (event: { target: { value: NotificationEmailMode } }) => void;
    }) => (
      <div>
        {options.map((option) => (
          <button
            data-testid={`mode-${option.value}`}
            disabled={option.disabled}
            key={option.value}
            onClick={() => onChange({ target: { value: option.value } })}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    ),
  },
  Space: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Table: ({ columns, dataSource, rowKey }: any) => (
    <table>
      <thead>
        <tr>
          {columns.map((column: any) => (
            <th key={column.key}>{column.title}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {dataSource.map((record: any) => (
          <tr
            data-testid={`notification-row-${record[rowKey]}`}
            key={record[rowKey]}
          >
            {columns.map((column: any) => (
              <td key={column.key}>
                {column.render
                  ? column.render(record[column.dataIndex], record)
                  : record[column.dataIndex]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
  Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Typography: {
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    communication: { defaultMessage: "Communication" },
  },
}));

function immutableLike(values: Record<string, unknown>) {
  return {
    get: (key: string) => values[key],
  };
}

describe("AccountPreferencesCommunication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useTypedRedux.mockImplementation((store: string, key: string) => {
      if (store === "account" && key === "other_settings") {
        return immutableLike({});
      }
      if (store === "account" && key === "stripe_customer") {
        return null;
      }
      if (store === "account" && key === "email_address") {
        return "user@example.com";
      }
      if (store === "account" && key === "email_address_verified") {
        return immutableLike({ "user@example.com": new Date() });
      }
      return undefined;
    });
  });

  it("renders category-based notification email preferences", () => {
    render(<AccountPreferencesCommunication />);

    expect(screen.getByText("Notifications")).toBeTruthy();
    expect(screen.getByText("Billing")).toBeTruthy();
    expect(screen.getByText("Security")).toBeTruthy();
    expect(screen.getByText("AI activity")).toBeTruthy();
    expect(screen.queryByText("Required immediate email")).toBeNull();
    expect(screen.queryByText("Show Announcement Banner")).toBeNull();
    expect(screen.queryByText("Hide free warnings")).toBeNull();
    expect(screen.queryByText(/Do NOT send email/i)).toBeNull();

    expect(
      screen
        .getAllByTestId(/^notification-row-/)
        .map((row) =>
          row.getAttribute("data-testid")?.replace("notification-row-", ""),
        ),
    ).toEqual([
      "security",
      "billing",
      "collaboration",
      "course",
      "support",
      "ai",
      "maintenance",
      "product",
    ]);

    const billingRow = screen.getByTestId("notification-row-billing");
    expect(
      (within(billingRow).getByTestId("mode-immediate") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (within(billingRow).getByTestId("mode-digest") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (within(billingRow).getByTestId("mode-off") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("persists notification_preferences when a category mode changes", () => {
    render(<AccountPreferencesCommunication />);

    fireEvent.click(
      within(screen.getByTestId("notification-row-ai")).getByTestId(
        "mode-immediate",
      ),
    );

    expect(setOtherSettings).toHaveBeenCalledWith(
      OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
      expect.objectContaining({
        version: 1,
        email: expect.objectContaining({
          ai: "immediate",
          billing: "immediate",
          security: "immediate",
        }),
      }),
    );
  });

  it("persists marketing consent and product email preference together", () => {
    render(<AccountPreferencesCommunication />);

    fireEvent.click(
      within(screen.getByTestId("notification-row-product")).getByTestId(
        "mode-digest",
      ),
    );

    expect(setOtherSettings).toHaveBeenCalledWith("newsletter", true);
    expect(setOtherSettings).toHaveBeenCalledWith(
      OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
      expect.objectContaining({
        email: expect.objectContaining({
          product: "digest",
        }),
      }),
    );
  });
});
