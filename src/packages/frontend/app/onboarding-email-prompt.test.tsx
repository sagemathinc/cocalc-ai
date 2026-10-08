/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { Map } from "immutable";
import type { ReactNode } from "react";

import { OnboardingEmailPrompt } from "./onboarding-email-prompt";

const PROJECT_ID = "00000000-1000-4000-8000-000000000000";
const setOtherSettingsMany = jest.fn();
const values: Record<string, unknown> = {};

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({
    set_other_settings_many: (...args: unknown[]) =>
      setOtherSettingsMany(...args),
  }),
  useTypedRedux: (store: string, key: string) => values[`${store}.${key}`],
}));

jest.mock("@cocalc/frontend/lite", () => ({ lite: false }));

jest.mock("antd", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick: () => void;
  }) => <button onClick={onClick}>{children}</button>,
  Card: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  Space: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Typography: {
    Paragraph: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  },
}));

function otherSettings(value: Record<string, unknown> = {}) {
  return {
    get: (key: string) => value[key],
  };
}

function setDefaultValues(): void {
  values["account.account_id"] = "account-1";
  values["account.is_ready"] = true;
  values["account.is_logged_in"] = true;
  values["account.impersonation"] = null;
  values["account.other_settings"] = otherSettings();
  values["page.active_top_tab"] = "projects";
  values["page.fullscreen"] = undefined;
  values["projects.project_map"] = Map();
  values["customize.email_enabled"] = true;
}

describe("OnboardingEmailPrompt", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    for (const key of Object.keys(values)) delete values[key];
    setDefaultValues();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("offers email guides after a zero-to-one project transition and open", () => {
    const view = render(<OnboardingEmailPrompt />);

    values["projects.project_map"] = Map([[PROJECT_ID, Map()]]);
    view.rerender(<OnboardingEmailPrompt />);
    expect(screen.queryByText("Get productive with CoCalc faster")).toBeNull();

    values["page.active_top_tab"] = PROJECT_ID;
    view.rerender(<OnboardingEmailPrompt />);
    act(() => jest.advanceTimersByTime(1_200));

    expect(screen.getByText("Get productive with CoCalc faster")).toBeTruthy();
    fireEvent.click(screen.getByText("Email me guides"));

    expect(setOtherSettingsMany).toHaveBeenCalledWith(
      expect.objectContaining({
        newsletter: true,
        marketing_email_consent_record: expect.objectContaining({
          version: 1,
          enabled: true,
          source: "first-project-open",
          recorded_at: expect.any(String),
        }),
        notification_preferences: expect.objectContaining({
          email: expect.objectContaining({
            onboarding: "immediate",
            product: "digest",
          }),
        }),
      }),
    );
    expect(screen.queryByText("Get productive with CoCalc faster")).toBeNull();
  });

  it("does not offer email guides when the site cannot send email", () => {
    values["customize.email_enabled"] = false;
    const view = render(<OnboardingEmailPrompt />);
    values["projects.project_map"] = Map([[PROJECT_ID, Map()]]);
    values["page.active_top_tab"] = PROJECT_ID;
    view.rerender(<OnboardingEmailPrompt />);
    act(() => jest.advanceTimersByTime(1_200));

    expect(screen.queryByText("Get productive with CoCalc faster")).toBeNull();
  });

  it("does not prompt when the initial project list is already nonempty", () => {
    values["projects.project_map"] = Map([[PROJECT_ID, Map()]]);
    values["page.active_top_tab"] = PROJECT_ID;

    render(<OnboardingEmailPrompt />);
    act(() => jest.advanceTimersByTime(1_200));

    expect(screen.queryByText("Get productive with CoCalc faster")).toBeNull();
  });

  it("records a declined offer so it is not shown again", () => {
    values["account.other_settings"] = otherSettings({
      notification_preferences: Map({
        email: Map({ mentions: "none" }),
      }),
    });
    const view = render(<OnboardingEmailPrompt />);
    values["projects.project_map"] = Map([[PROJECT_ID, Map()]]);
    values["page.active_top_tab"] = PROJECT_ID;
    view.rerender(<OnboardingEmailPrompt />);
    act(() => jest.advanceTimersByTime(1_200));

    fireEvent.click(screen.getByText("No thanks"));

    expect(setOtherSettingsMany).toHaveBeenCalledWith(
      expect.objectContaining({
        newsletter: false,
        marketing_email_consent_record: expect.objectContaining({
          enabled: false,
          source: "first-project-open",
        }),
        notification_preferences: expect.objectContaining({
          email: expect.objectContaining({
            mentions: "none",
            onboarding: "off",
            product: "off",
          }),
        }),
      }),
    );
  });
});
