/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
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
  FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) => (
    <span>{defaultMessage}</span>
  ),
  useIntl: () => ({
    formatMessage: (message: { defaultMessage?: string }) =>
      message.defaultMessage ?? "Communication",
  }),
}));

jest.mock("antd", () => ({
  Alert: ({ message }: { message: string }) => <div>{message}</div>,
  Radio: {
    Group: ({
      options,
      onChange,
    }: {
      options: { value: NotificationEmailMode; label: string }[];
      onChange: (event: { target: { value: NotificationEmailMode } }) => void;
    }) => (
      <div>
        {options.map((option) => (
          <button
            data-testid={`mode-${option.value}`}
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
  Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Typography: {
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Paragraph: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  },
}));

jest.mock("@cocalc/frontend/antd-bootstrap", () => ({
  Panel: ({ children, header }: any) => (
    <section>
      <h1>{header}</h1>
      {children}
    </section>
  ),
  Switch: ({ children }: { children: ReactNode }) => <label>{children}</label>,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    communication: { defaultMessage: "Communication" },
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    server_time: () => 123,
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

    expect(screen.getByText("Notification email")).toBeTruthy();
    expect(screen.getByText("Billing and spend")).toBeTruthy();
    expect(screen.getByText("Security and access")).toBeTruthy();
    expect(screen.getByText("AI and Codex")).toBeTruthy();
    expect(screen.getAllByText("Required immediate email")).toHaveLength(2);
    expect(screen.queryByText(/Do NOT send email/i)).toBeNull();
  });

  it("persists notification_preferences when a category mode changes", () => {
    render(<AccountPreferencesCommunication />);

    // Editable rows are support, collaboration, ai, product, maintenance, course.
    fireEvent.click(screen.getAllByTestId("mode-immediate")[2]);

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
});
