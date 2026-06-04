/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MembershipPage } from "../membership-page";

const useMembershipSettingsData = jest.fn();
const refresh = jest.fn();

jest.mock("../membership-settings-data", () => ({
  useMembershipSettingsData: () => useMembershipSettingsData(),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string, key: string) =>
    store === "customize" && key === "is_commercial",
}));

jest.mock("react-intl", () => ({
  defineMessage: (message: unknown) => message,
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    membership: { defaultMessage: "Membership" },
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>loading</div>,
}));

jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: () => null,
}));

jest.mock("../settings-routing", () => ({
  openAccountSettings: jest.fn(),
}));

jest.mock("../membership-package-manager", () => ({
  ClaimableMembershipPackagesPanel: () => <button>Claim site license</button>,
  SiteLicenseReverificationPanel: () => null,
}));

jest.mock("../membership-purchase-modal", () => () => null);

jest.mock("../balance-toward-subs", () => ({
  UseBalance: () => <div>balance-renewal-control</div>,
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: (fn: () => Promise<void>) => fn(),
  }),
}));

jest.mock("@cocalc/frontend/purchases/api", () => ({
  cancelSubscription: jest.fn(),
  resumeSubscription: jest.fn(),
}));

jest.mock("antd", () => {
  const Box = ({
    children,
    message,
    title,
  }: {
    children?: ReactNode;
    message?: ReactNode;
    title?: ReactNode;
  }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {message}
      {children}
    </section>
  );
  return {
    Alert: Box,
    Button: ({ children, onClick }: any) => (
      <button onClick={onClick} type="button">
        {children}
      </button>
    ),
    Card: Box,
    Popconfirm: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Space: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Table: ({ columns, dataSource }: any) => (
      <table>
        <tbody>
          {dataSource.map((row: any) => (
            <tr key={row.key}>
              {columns.map((column: any) => (
                <td key={column.dataIndex}>
                  {column.render
                    ? column.render(row[column.dataIndex], row)
                    : row[column.dataIndex]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    Typography: {
      Paragraph: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
      Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    },
  };
});

function baseData(overrides: Record<string, unknown>) {
  return {
    account_id: "account-1",
    candidateRows: [],
    details: { candidates: [], selected: overrides.membership },
    error: "",
    loading: false,
    refresh,
    tierById: {},
    ...overrides,
  };
}

describe("MembershipPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows the free effective membership without raw technical details", () => {
    useMembershipSettingsData.mockReturnValue(
      baseData({
        membership: { class: "free", source: "free" },
        tierById: {
          free: {
            id: "free",
            label: "Free",
            price_monthly: 0,
            price_yearly: 0,
            store_description:
              "Start using CoCalc with just enough resources to explore the platform and do basic work.",
            store_highlights: [],
            features: { project_host_tier: 0 },
            usage_limits: {
              max_sponsored_running_projects: 1,
              shared_compute_priority: 1,
            },
          },
        },
      }),
    );

    const { container } = render(<MembershipPage />);
    const text = container.textContent ?? "";

    expect(screen.getByText("Free - CoCalc")).toBeTruthy();
    expect(
      screen.getByText(
        "Start using CoCalc with just enough resources to explore the platform and do basic work.",
      ),
    ).toBeTruthy();
    expect(text.indexOf("Effective membership")).toBeLessThan(
      text.indexOf("Membership sources"),
    );
    expect(text).toContain("No active membership sources.");
    expect(text).toContain("balance-renewal-control");
    expect(text).not.toContain("$0.00");
    expect(text).not.toContain("Project host tier");
    expect(text).not.toContain("Shared compute priority");
    expect(text).not.toContain("SourceFree");
  });

  it("shows personal annual membership pricing from subscription data", () => {
    useMembershipSettingsData.mockReturnValue(
      baseData({
        candidateRows: [
          {
            expires: "2027-06-04T00:00:00.000Z",
            key: "subscription-standard-1",
            selected: true,
            source: "Personal membership",
            sourceDetail: "Managed here by you.",
            status: "Used",
            subscriptionStatus: "active",
            tier: "Standard",
          },
        ],
        membership: {
          class: "standard",
          source: "subscription",
          subscription_cost: 216,
          subscription_interval: "year",
        },
        tierById: {
          standard: {
            id: "standard",
            label: "Standard",
            store_description: "A solid choice for everyday work.",
            store_highlights: [
              "Better shared resources",
              "Dedicated project host access, including GPU",
              "More included AI usage",
            ],
          },
        },
      }),
    );

    const { container } = render(<MembershipPage />);
    const text = container.textContent ?? "";

    expect(
      screen.getByText(
        "Standard ($18/month, billed annually) - Personal membership",
      ),
    ).toBeTruthy();
    expect(screen.getByText("A solid choice for everyday work.")).toBeTruthy();
    expect(screen.getByText("Better shared resources")).toBeTruthy();
    expect(
      screen.getByText("Dedicated project host access, including GPU"),
    ).toBeTruthy();
    expect(screen.getByText("More included AI usage")).toBeTruthy();
    expect(text).not.toContain("Billing:");
    expect(text).not.toContain("Limits:");
  });
});
