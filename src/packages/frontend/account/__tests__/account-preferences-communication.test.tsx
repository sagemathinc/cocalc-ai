/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AccountPreferencesCommunication } from "../account-preferences-communication";
import {
  MARKETING_CONSENT_OTHER_SETTINGS_KEY,
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
  Select: ({
    options,
    onChange,
    value,
  }: {
    options: {
      disabled?: boolean;
      value: NotificationEmailMode;
      label: string;
    }[];
    onChange: (value: NotificationEmailMode) => void;
    value: NotificationEmailMode;
  }) => (
    <select
      data-testid="delivery-mode"
      onChange={(event) =>
        onChange(event.currentTarget.value as NotificationEmailMode)
      }
      value={value}
    >
      {options.map((option) => (
        <option
          disabled={option.disabled}
          key={option.value}
          value={option.value}
        >
          {option.label}
        </option>
      ))}
    </select>
  ),
  Space: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Switch: ({
    checked,
    onChange,
    ...props
  }: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    "aria-label"?: string;
  }) => (
    <input
      aria-label={props["aria-label"]}
      checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
      type="checkbox"
    />
  ),
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
    expect(screen.getByText("Membership requests")).toBeTruthy();
    expect(screen.getByText("Access requests")).toBeTruthy();
    expect(screen.getByText("Mentions")).toBeTruthy();
    expect(screen.getByText("Chat replies")).toBeTruthy();
    expect(screen.getByText("AI activity")).toBeTruthy();
    expect(screen.getByText("Onboarding and marketing emails")).toBeTruthy();
    expect(screen.queryByText("project invitations")).toBeNull();
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
      "membership_requests",
      "access_requests",
      "mentions",
      "chat_replies",
      "ai",
      "course",
      "support",
      "maintenance",
      "product",
    ]);

    const billingRow = screen.getByTestId("notification-row-billing");
    const billingSelect = within(billingRow).getByTestId(
      "delivery-mode",
    ) as HTMLSelectElement;
    expect(
      Array.from(billingSelect.options).map(({ disabled, text, value }) => ({
        disabled,
        text,
        value,
      })),
    ).toEqual([
      {
        disabled: false,
        text: "Immediate email and in-app",
        value: "immediate",
      },
      { disabled: true, text: "Digest email and in-app", value: "digest" },
      { disabled: true, text: "In-app only", value: "off" },
      { disabled: true, text: "None", value: "none" },
    ]);

    const membershipRow = screen.getByTestId(
      "notification-row-membership_requests",
    );
    const membershipSelect = within(membershipRow).getByTestId(
      "delivery-mode",
    ) as HTMLSelectElement;
    expect(
      Array.from(membershipSelect.options).map(({ disabled, text, value }) => ({
        disabled,
        text,
        value,
      })),
    ).toEqual([
      {
        disabled: false,
        text: "Immediate email and in-app",
        value: "immediate",
      },
      { disabled: false, text: "Digest email and in-app", value: "digest" },
      { disabled: true, text: "In-app only", value: "off" },
      { disabled: true, text: "None", value: "none" },
    ]);

    const accessRow = screen.getByTestId("notification-row-access_requests");
    const accessSelect = within(accessRow).getByTestId(
      "delivery-mode",
    ) as HTMLSelectElement;
    expect(
      Array.from(accessSelect.options).map(({ disabled, text, value }) => ({
        disabled,
        text,
        value,
      })),
    ).toEqual([
      {
        disabled: false,
        text: "Immediate email and in-app",
        value: "immediate",
      },
      { disabled: false, text: "Digest email and in-app", value: "digest" },
      { disabled: false, text: "In-app only", value: "off" },
      { disabled: false, text: "None", value: "none" },
    ]);
  });

  it("persists notification_preferences when a category mode changes", () => {
    render(<AccountPreferencesCommunication />);

    fireEvent.change(
      within(screen.getByTestId("notification-row-ai")).getByTestId(
        "delivery-mode",
      ),
      { target: { value: "immediate" } },
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

  it("persists product email preference independently of marketing consent", () => {
    render(<AccountPreferencesCommunication />);

    fireEvent.change(
      within(screen.getByTestId("notification-row-product")).getByTestId(
        "delivery-mode",
      ),
      { target: { value: "digest" } },
    );

    expect(setOtherSettings).toHaveBeenCalledWith(
      OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
      expect.objectContaining({
        email: expect.objectContaining({
          product: "digest",
        }),
      }),
    );
    expect(setOtherSettings).not.toHaveBeenCalledWith(
      MARKETING_CONSENT_OTHER_SETTINGS_KEY,
      expect.anything(),
    );
  });

  it("persists onboarding and marketing email consent separately", () => {
    render(<AccountPreferencesCommunication />);

    fireEvent.click(
      screen.getByLabelText("Allow optional onboarding and marketing emails"),
    );

    expect(setOtherSettings).toHaveBeenCalledWith(
      MARKETING_CONSENT_OTHER_SETTINGS_KEY,
      true,
    );
  });

  it("persists none delivery mode for optional notification categories", () => {
    render(<AccountPreferencesCommunication />);

    fireEvent.change(
      within(screen.getByTestId("notification-row-mentions")).getByTestId(
        "delivery-mode",
      ),
      { target: { value: "none" } },
    );

    expect(setOtherSettings).toHaveBeenCalledWith(
      OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
      expect.objectContaining({
        email: expect.objectContaining({
          mentions: "none",
        }),
      }),
    );
  });
});
