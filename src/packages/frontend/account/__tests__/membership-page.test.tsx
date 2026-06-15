/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MembershipPage } from "../membership-page";

const useMembershipSettingsData = jest.fn();
const mockClaimableMembershipPackagesPanel = jest.fn();
const mockMembershipPurchaseModal = jest.fn();
const refresh = jest.fn();

jest.mock("../membership-settings-data", () => ({
  useMembershipSettingsData: () => useMembershipSettingsData(),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string, key: string) =>
    store === "customize" && key === "stripe_enabled",
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
  ClaimableMembershipPackagesPanel: (props: unknown) => {
    mockClaimableMembershipPackagesPanel(props);
    return <div>site license panel</div>;
  },
  SiteLicenseReverificationPanel: () => null,
}));

jest.mock("../membership-purchase-modal", () => (props: unknown) => {
  mockMembershipPurchaseModal(props);
  return null;
});

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
    Modal: ({ open, ...props }: any) => (open ? <Box {...props} /> : null),
    Popconfirm: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Space: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Table: ({ columns, dataSource }: any) => (
      <table>
        <tbody>
          {dataSource.map((row: any) => (
            <tr key={row.key}>
              {columns.map((column: any) => (
                <td key={column.dataIndex ?? column.key ?? column.title}>
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
    candidateRows: [
      {
        action: "personal",
        class: "free",
        key: "free-personal-default",
        membership: "Free",
        note: "No scheduled end",
        selected: overrides.membership?.["source"] === "free",
        source: "Personal",
        sourceKind: "free",
        state: "Active",
      },
    ],
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("refreshes membership state after personal membership changes", async () => {
    useMembershipSettingsData.mockReturnValue(
      baseData({
        membership: { class: "free", source: "free" },
      }),
    );
    const dispatchEvent = jest.spyOn(window, "dispatchEvent");

    render(<MembershipPage />);
    fireEvent.click(await screen.findByText("Manage site license membership"));
    await screen.findByText("site license panel");
    const props = mockMembershipPurchaseModal.mock.calls[0][0] as {
      onClose: () => void;
      onChanged: () => void;
    };
    await act(async () => {
      props.onChanged();
    });

    expect(refresh).toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledWith(expect.any(Event));
    expect(dispatchEvent.mock.calls.at(-1)?.[0].type).toBe(
      "cocalc:membership-changed",
    );
    await waitFor(() => {
      expect(
        mockClaimableMembershipPackagesPanel.mock.calls.at(-1)?.[0],
      ).toEqual(expect.objectContaining({ refreshToken: 1 }));
    });

    refresh.mockClear();
    dispatchEvent.mockClear();
    await act(async () => {
      props.onClose();
    });

    expect(refresh).toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledWith(expect.any(Event));
  });

  it("shows the free effective membership without raw technical details", async () => {
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
    await screen.findByText("Manage site license membership");
    const text = container.textContent ?? "";

    expect(screen.getByText("Free - Personal")).toBeTruthy();
    expect(
      screen.getByText(
        "Start using CoCalc with just enough resources to explore the platform and do basic work.",
      ),
    ).toBeTruthy();
    expect(text.indexOf("Effective membership")).toBeLessThan(
      text.indexOf("Membership sources"),
    );
    expect(text).toContain("PersonalFreeActiveNo scheduled endManage");
    expect(text).toContain("balance-renewal-control");
    expect(text).not.toContain("$0.00");
    expect(text).not.toContain("Project host tier");
    expect(text).not.toContain("Shared compute priority");
    expect(text).not.toContain("SourceFree");
  });

  it("shows personal annual membership pricing from subscription data", async () => {
    useMembershipSettingsData.mockReturnValue(
      baseData({
        candidateRows: [
          {
            action: "personal",
            class: "standard",
            key: "subscription-standard-1",
            membership: "Standard",
            note: "Renews June 4, 2027",
            selected: true,
            source: "Personal",
            sourceKind: "subscription",
            state: "Active",
            subscriptionInterval: "year",
            subscriptionStatus: "active",
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
    await screen.findByText("Manage site license membership");
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

  it("opens the shared site-license modal from the bottom button", async () => {
    useMembershipSettingsData.mockReturnValue(
      baseData({
        membership: { class: "free", source: "free" },
      }),
    );

    render(<MembershipPage />);
    fireEvent.click(await screen.findByText("Manage site license membership"));

    expect(screen.getByText("site license panel")).toBeTruthy();
    expect(mockClaimableMembershipPackagesPanel.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        onChanged: expect.any(Function),
        onSiteLicenseTitleChange: expect.any(Function),
      }),
    );

    const panelProps = mockClaimableMembershipPackagesPanel.mock.calls.at(
      -1,
    )?.[0] as {
      onSiteLicenseTitleChange: (title?: string) => void;
    };
    await act(async () => {
      panelProps.onSiteLicenseTitleChange("CoCalc Trial");
    });

    expect(screen.getByText("Manage CoCalc Trial membership")).toBeTruthy();
  });

  it("opens the shared site-license modal from a site-license source row", async () => {
    useMembershipSettingsData.mockReturnValue(
      baseData({
        candidateRows: [
          {
            action: "site-license",
            class: "standard",
            key: "grant-standard-1",
            membership: "Researcher",
            note: "Ends June 4, 2027",
            selected: true,
            source: "CoCalc Trial",
            sourceKind: "grant",
            state: "Active",
          },
        ],
        details: {
          candidates: [
            {
              class: "standard",
              grant_source: "site-license",
              source: "grant",
            },
          ],
          selected: { class: "standard", source: "grant" },
        },
        membership: {
          class: "standard",
          grant_source: "site-license",
          source: "grant",
        },
        tierById: {
          standard: {
            id: "standard",
            label: "Standard",
            store_description: "A solid choice for everyday work.",
            store_highlights: [],
          },
        },
      }),
    );

    render(<MembershipPage />);

    expect(screen.getByText("Researcher - CoCalc Trial")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));

    expect(screen.getByText("Manage CoCalc Trial membership")).toBeTruthy();
    expect(screen.getByText("site license panel")).toBeTruthy();
    expect(mockClaimableMembershipPackagesPanel.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        onChanged: expect.any(Function),
        onSiteLicenseTitleChange: expect.any(Function),
      }),
    );
  });
});
