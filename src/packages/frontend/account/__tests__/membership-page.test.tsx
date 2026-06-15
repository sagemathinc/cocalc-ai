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
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MembershipPage } from "../membership-page";

const useMembershipSettingsData = jest.fn();
const mockClaimableMembershipPackagesPanel = jest.fn();
const mockMembershipPurchaseModal = jest.fn();
const getSiteLicenseAffiliationReverificationStatus = jest.fn();
const refreshSiteLicenseAffiliationVerification = jest.fn();
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
}));

jest.mock("../membership-purchase-modal", () => (props: unknown) => {
  mockMembershipPurchaseModal(props);
  return null;
});

jest.mock("../balance-toward-subs", () => ({
  UseBalance: () => <div>balance-renewal-control</div>,
}));

jest.mock("@cocalc/frontend/purchases/api", () => ({
  getSiteLicenseAffiliationReverificationStatus: (...args: any[]) =>
    getSiteLicenseAffiliationReverificationStatus(...args),
  refreshSiteLicenseAffiliationVerification: (...args: any[]) =>
    refreshSiteLicenseAffiliationVerification(...args),
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
  const Modal = Object.assign(
    ({ open, ...props }: any) => (open ? <Box {...props} /> : null),
    {
      error: jest.fn(),
      success: jest.fn(),
    },
  );
  return {
    Alert: Box,
    Button: ({ children, onClick }: any) => (
      <button onClick={onClick} type="button">
        {children}
      </button>
    ),
    Card: Box,
    Modal,
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
    getSiteLicenseAffiliationReverificationStatus.mockResolvedValue({
      grace_expired_count: 0,
      pending_count: 0,
      seats: [],
    });
    refreshSiteLicenseAffiliationVerification.mockResolvedValue([]);
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

    expect(screen.getByText("Effective: Personal - Free")).toBeTruthy();
    expect(
      screen.getByText(
        "Start using CoCalc with just enough resources to explore the platform and do basic work.",
      ),
    ).toBeTruthy();
    expect(text.indexOf("Effective: Personal - Free")).toBeLessThan(
      text.indexOf("Memberships"),
    );
    expect(text).toContain("PersonalFreeActiveNo scheduled endManage");
    expect(text).not.toContain("balance-renewal-control");
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
        details: {
          candidates: [
            {
              class: "standard",
              source: "subscription",
              subscription_cost: 216,
              subscription_interval: "year",
              subscription_status: "active",
              expires: new Date("2027-06-04T12:00:00Z"),
            },
          ],
          selected: { class: "standard", source: "subscription" },
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

    expect(screen.getByText("Effective: Personal - Standard")).toBeTruthy();
    expect(screen.getByText("A solid choice for everyday work.")).toBeTruthy();
    expect(screen.getByText("Better shared resources")).toBeTruthy();
    expect(
      screen.getByText("Dedicated project host access, including GPU"),
    ).toBeTruthy();
    expect(screen.getByText("More included AI usage")).toBeTruthy();
    expect(screen.getByText("Personal membership billing")).toBeTruthy();
    expect(
      screen.getByText("Standard: $18/month, billed annually."),
    ).toBeTruthy();
    expect(screen.getByText("Next charge: $216 on June 4, 2027.")).toBeTruthy();
    expect(text).toContain("balance-renewal-control");
    expect(text).not.toContain("Configure personal membership");
    expect(text).not.toContain("Cancel...");
    expect(text).not.toContain("Billing:");
    expect(text).not.toContain("Limits:");
  });

  it("shows paid personal membership details when another membership is effective", async () => {
    useMembershipSettingsData.mockReturnValue(
      baseData({
        candidateRows: [
          {
            action: "personal",
            class: "standard",
            key: "subscription-standard-1",
            membership: "Standard",
            note: "Renews June 4, 2027",
            selected: false,
            source: "Personal",
            sourceKind: "subscription",
            state: "Active",
            subscriptionInterval: "year",
            subscriptionStatus: "active",
          },
          {
            action: "site-license",
            class: "pro",
            key: "grant-pro-1",
            membership: "Researcher",
            note: "No scheduled end",
            poolDescription: "Use CoCalc for advanced research projects.",
            priority: 20,
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
              source: "subscription",
              subscription_cost: 216,
              subscription_interval: "year",
              subscription_status: "active",
              expires: new Date("2027-06-04T12:00:00Z"),
            },
            {
              class: "pro",
              grant_source: "site-license",
              source: "grant",
            },
          ],
          selected: { class: "pro", source: "grant" },
        },
        membership: {
          class: "pro",
          grant_source: "site-license",
          pool_description: "Use CoCalc for advanced research projects.",
          source: "grant",
        },
        tierById: {
          pro: {
            id: "pro",
            label: "Pro",
            store_description: "A higher level for demanding work.",
            store_highlights: [],
          },
          standard: {
            id: "standard",
            label: "Standard",
          },
        },
      }),
    );

    const { container } = render(<MembershipPage />);
    await screen.findByText("Effective: CoCalc Trial - Researcher");

    expect(
      screen.getByText("Use CoCalc for advanced research projects."),
    ).toBeTruthy();
    expect(screen.queryByText("A higher level for demanding work.")).toBeNull();
    expect(
      screen.getByText("Standard: $18/month, billed annually."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "This personal membership is not currently used because another membership has higher priority.",
      ),
    ).toBeTruthy();
    expect(container.textContent).toContain("balance-renewal-control");
  });

  it("does not show the renewal balance switch for canceled personal membership", async () => {
    useMembershipSettingsData.mockReturnValue(
      baseData({
        candidateRows: [
          {
            action: "personal",
            class: "standard",
            key: "subscription-standard-1",
            membership: "Standard",
            note: "Ends June 4, 2027",
            selected: true,
            source: "Personal",
            sourceKind: "subscription",
            state: "Renewal canceled",
            subscriptionInterval: "year",
            subscriptionStatus: "canceled",
          },
        ],
        details: {
          candidates: [
            {
              class: "standard",
              source: "subscription",
              subscription_cost: 216,
              subscription_interval: "year",
              subscription_status: "canceled",
              expires: new Date("2027-06-04T12:00:00Z"),
            },
          ],
          selected: { class: "standard", source: "subscription" },
        },
        membership: {
          class: "standard",
          source: "subscription",
          subscription_cost: 216,
          subscription_interval: "year",
          subscription_status: "canceled",
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

    const { container } = render(<MembershipPage />);
    await screen.findByText("Personal membership billing");

    expect(
      screen.getByText("Ends June 4, 2027. Renewal is canceled."),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("balance-renewal-control");
  });

  it("opens canceled personal membership management from the active personal baseline", async () => {
    useMembershipSettingsData.mockReturnValue(
      baseData({
        candidateRows: [
          {
            action: "personal",
            class: "standard",
            key: "subscription-standard-1",
            membership: "Standard",
            note: "Ends June 4, 2027",
            selected: true,
            source: "Personal",
            sourceKind: "subscription",
            state: "Renewal canceled",
            subscriptionInterval: "year",
            subscriptionStatus: "canceled",
          },
          {
            action: "personal",
            class: "basic",
            key: "subscription-basic-1",
            membership: "Basic",
            note: "Renews June 4, 2027",
            selected: false,
            source: "Personal",
            sourceKind: "subscription",
            state: "Active",
            subscriptionInterval: "month",
            subscriptionStatus: "active",
          },
        ],
        details: {
          candidates: [],
          selected: { class: "standard", source: "subscription" },
        },
        membership: {
          class: "standard",
          source: "subscription",
          subscription_interval: "year",
          subscription_status: "canceled",
        },
      }),
    );

    render(<MembershipPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Manage" })[0]);

    await waitFor(() => {
      expect(mockMembershipPurchaseModal.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          currentClassOverride: "basic",
          currentIntervalOverride: "month",
          open: true,
        }),
      );
    });
  });

  it("opens canceled personal membership management from Free when no active personal subscription exists", async () => {
    useMembershipSettingsData.mockReturnValue(
      baseData({
        candidateRows: [
          {
            action: "personal",
            class: "standard",
            key: "subscription-standard-1",
            membership: "Standard",
            note: "Ends June 4, 2027",
            selected: true,
            source: "Personal",
            sourceKind: "subscription",
            state: "Renewal canceled",
            subscriptionInterval: "year",
            subscriptionStatus: "canceled",
          },
        ],
        details: {
          candidates: [],
          selected: { class: "standard", source: "subscription" },
        },
        membership: {
          class: "standard",
          source: "subscription",
          subscription_interval: "year",
          subscription_status: "canceled",
        },
      }),
    );

    render(<MembershipPage />);
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));

    await waitFor(() => {
      expect(mockMembershipPurchaseModal.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          currentClassOverride: "free",
          currentIntervalOverride: undefined,
          open: true,
        }),
      );
    });
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

    expect(
      screen.getByText("Effective: CoCalc Trial - Researcher"),
    ).toBeTruthy();
    expect(screen.queryByText("Manage site license membership")).toBeNull();
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

  it("shows site-license reverification in the membership source row", async () => {
    refreshSiteLicenseAffiliationVerification.mockResolvedValue([
      {
        account_id: "account-1",
        assignment_id: "assignment-1",
        exclusive_group: "researcher",
        membership_class: "standard",
        package_id: "package-1",
        pool_name: "Researcher",
        reverification_due_at: new Date("2999-06-14T12:00:00Z"),
        site_license_id: "license-1",
        state: "current",
        verification_policy: "email-domain",
      },
    ]);
    getSiteLicenseAffiliationReverificationStatus.mockResolvedValue({
      grace_expired_count: 0,
      pending_count: 0,
      seats: [
        {
          account_id: "account-1",
          assignment_id: "assignment-1",
          can_refresh_with_verified_email: true,
          exclusive_group: "researcher",
          membership_class: "standard",
          package_id: "package-1",
          pool_name: "Researcher",
          reverification_due_at: new Date("2999-06-14T00:00:00Z"),
          site_license_id: "license-1",
          state: "current",
          verification_policy: "email-domain",
        },
      ],
    });
    useMembershipSettingsData.mockReturnValue(
      baseData({
        candidateRows: [
          {
            action: "site-license",
            class: "standard",
            grantPackageId: "package-1",
            key: "grant-standard-1",
            membership: "Researcher",
            note: "Ends June 4, 2027",
            selected: true,
            siteLicenseId: "license-1",
            source: "CoCalc Trial",
            sourceKind: "grant",
            state: "Active",
          },
        ],
        details: {
          candidates: [
            {
              class: "standard",
              grant_package_id: "package-1",
              grant_source: "site-license",
              site_license_id: "license-1",
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
      }),
    );

    render(<MembershipPage />);
    await screen.findByText(/Reverify by/);

    const row = screen.getByText("Researcher").closest("tr")!;
    expect(
      within(row)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Manage", "Reverify"]);
    expect(screen.queryByText("Site-license affiliation")).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Reverify" }));

    await waitFor(() => {
      expect(refreshSiteLicenseAffiliationVerification).toHaveBeenCalledWith({
        site_license_id: "license-1",
      });
    });
    const { Modal } = jest.requireMock("antd") as {
      Modal: { success: jest.Mock };
    };
    expect(Modal.success).toHaveBeenCalledWith({
      title: "Affiliation reverified",
      content:
        "Your site-license membership affiliation was reverified. Reverify by June 14, 2999.",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("does not show reverification controls on pending approval rows", async () => {
    getSiteLicenseAffiliationReverificationStatus.mockResolvedValue({
      grace_expired_count: 0,
      pending_count: 0,
      seats: [
        {
          account_id: "account-1",
          assignment_id: "assignment-1",
          can_refresh_with_verified_email: true,
          exclusive_group: "researcher",
          membership_class: "standard",
          package_id: "package-1",
          pool_name: "Researcher",
          reverification_due_at: new Date("2999-06-14T00:00:00Z"),
          site_license_id: "license-1",
          state: "current",
          verification_policy: "email-domain",
        },
      ],
    });
    useMembershipSettingsData.mockReturnValue(
      baseData({
        candidateRows: [
          {
            action: "site-license",
            class: "standard",
            grantPackageId: "package-1",
            key: "grant-standard-1",
            membership: "Researcher",
            note: "Ends June 4, 2027",
            selected: true,
            siteLicenseId: "license-1",
            source: "CoCalc Trial",
            sourceKind: "grant",
            state: "Active",
          },
          {
            action: "site-license",
            class: "pro",
            key: "site-request-package-2",
            membership: "Instructor",
            note: "Awaiting manager approval",
            selected: false,
            siteLicenseId: "license-1",
            source: "CoCalc Trial",
            sourceKind: "site-request",
            state: "Pending approval",
          },
        ],
        membership: {
          class: "standard",
          grant_source: "site-license",
          source: "grant",
        },
      }),
    );

    render(<MembershipPage />);
    await screen.findByText(/Reverify by/);

    expect(screen.queryByText("Manage site license membership")).toBeNull();
    const pendingRow = screen.getByText("Instructor").closest("tr")!;
    expect(
      within(pendingRow).getByText("Awaiting manager approval"),
    ).toBeTruthy();
    expect(
      within(pendingRow)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Manage"]);
  });

  it("shows overdue site-license reverification as due now", async () => {
    getSiteLicenseAffiliationReverificationStatus.mockResolvedValue({
      grace_expired_count: 1,
      pending_count: 0,
      seats: [
        {
          account_id: "account-1",
          assignment_id: "assignment-1",
          can_refresh_with_verified_email: true,
          exclusive_group: "researcher",
          membership_class: "standard",
          package_id: "package-1",
          pool_name: "Researcher",
          reverification_due_at: new Date("2000-06-14T00:00:00Z"),
          site_license_id: "license-1",
          state: "grace_expired",
          verification_policy: "email-domain",
        },
      ],
    });
    useMembershipSettingsData.mockReturnValue(
      baseData({
        candidateRows: [
          {
            action: "site-license",
            class: "standard",
            grantPackageId: "package-1",
            key: "grant-standard-1",
            membership: "Researcher",
            note: "Ends June 4, 2027",
            selected: true,
            siteLicenseId: "license-1",
            source: "CoCalc Trial",
            sourceKind: "grant",
            state: "Active",
          },
        ],
        membership: {
          class: "standard",
          grant_source: "site-license",
          source: "grant",
        },
      }),
    );

    render(<MembershipPage />);

    expect(await screen.findByText("Reverify now")).toBeTruthy();
  });
});
