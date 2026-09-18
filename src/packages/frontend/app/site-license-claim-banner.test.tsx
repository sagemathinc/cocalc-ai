/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Map } from "immutable";
import { cloneElement } from "react";

import {
  activeProjectIdForSiteLicenseBanner,
  hasVisibleStudentCourseProject,
  SiteLicenseClaimBanner,
  sortSiteLicenseOpportunities,
  useSiteLicenseClaimBannerState,
} from "./site-license-claim-banner";

const claimMembershipPackageSeat = jest.fn();
const getClaimableMembershipPackages = jest.fn();
const requestSiteLicensePool = jest.fn();
const setOtherSettings = jest.fn();
const localStorage = new globalThis.Map<string, unknown>();

let accountId = "account-1";
let activeProjectTab: string | undefined;
let dismissals: Record<string, number> = {};
let projectMap = Map<string, any>();

jest.mock("antd", () => ({
  Alert: ({ title, type }: any) => (
    <div role="alert" data-type={type}>
      {title}
    </div>
  ),
  Button: ({ children, loading, onClick }: any) => (
    <button disabled={loading} onClick={onClick} type="button">
      {children}
    </button>
  ),
  Modal: ({ children, onCancel, open, title }: any) =>
    open ? (
      <div aria-label={title} role="dialog">
        <button aria-label="Close dialog" onClick={onCancel} type="button" />
        {children}
      </div>
    ) : null,
  Popconfirm: ({ children, onConfirm }: any) =>
    cloneElement(children, { onClick: onConfirm }),
  Space: ({ children }: any) => <div>{children}</div>,
  Typography: {
    Text: ({ children }: any) => <span>{children}</span>,
  },
}));

jest.mock("@cocalc/frontend/account/membership-package-manager", () => ({
  ClaimableMembershipPackagesPanel: ({ siteOnly }: any) => (
    <div>
      {siteOnly ? "Site-only membership manager" : "Membership manager"}
    </div>
  ),
}));

jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: jest.fn(),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({ set_other_settings: setOtherSettings }),
  useTypedRedux: (store: any, field: string) => {
    if (typeof store === "object") return activeProjectTab;
    if (store === "account" && field === "account_id") return accountId;
    if (store === "account" && field === "is_ready") return true;
    if (store === "account" && field === "is_logged_in") return true;
    if (store === "account" && field === "impersonation") return null;
    if (store === "account" && field === "other_settings") {
      return { get: () => dismissals };
    }
    if (store === "projects" && field === "project_map") return projectMap;
    if (store === "page" && field === "active_top_tab") return "projects";
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>Loading</div>,
}));

jest.mock("@cocalc/frontend/misc/local-storage-typed", () => ({
  get: (key: string[]) => localStorage.get(key.join("/")),
  set: (key: string[], value: unknown) =>
    localStorage.set(key.join("/"), value),
}));

jest.mock("@cocalc/frontend/purchases/api", () => ({
  claimMembershipPackageSeat: (...args: unknown[]) =>
    claimMembershipPackageSeat(...args),
  getClaimableMembershipPackages: (...args: unknown[]) =>
    getClaimableMembershipPackages(...args),
  requestSiteLicensePool: (...args: unknown[]) =>
    requestSiteLicensePool(...args),
}));

function opportunity(overrides: Record<string, unknown> = {}): any {
  return {
    available_seat_count: 10,
    kind: "site",
    matched_email_address: "student@example.edu",
    membership_class: "standard",
    organization_name: "Example University",
    owner_account_id: "owner-1",
    package_id: "package-1",
    pool_name: "Student membership",
    reason: "domain-match",
    seat_status: "claimable",
    site_license_id: "site-1",
    ...overrides,
  };
}

function Harness() {
  const state = useSiteLicenseClaimBannerState({ enabled: true });
  return <SiteLicenseClaimBanner state={state} />;
}

describe("SiteLicenseClaimBanner", () => {
  it("does not treat application routes as project ids", () => {
    expect(activeProjectIdForSiteLicenseBanner("agents")).toBe("");
    expect(activeProjectIdForSiteLicenseBanner("projects")).toBe("");
    expect(
      activeProjectIdForSiteLicenseBanner(
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toBe("11111111-1111-4111-8111-111111111111");
  });

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    accountId = "account-1";
    activeProjectTab = undefined;
    dismissals = {};
    projectMap = Map<string, any>();
    claimMembershipPackageSeat.mockResolvedValue({ id: "assignment-1" });
    requestSiteLicensePool.mockResolvedValue({ id: "request-1" });
  });

  it("offers a direct one-click claim using the site-only query", async () => {
    getClaimableMembershipPackages.mockResolvedValue([opportunity()]);
    render(<Harness />);

    fireEvent.click(await screen.findByRole("button", { name: "Claim now" }));

    await waitFor(() =>
      expect(claimMembershipPackageSeat).toHaveBeenCalledWith({
        package_id: "package-1",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(getClaimableMembershipPackages).toHaveBeenCalledWith({
      include_claimed_site_license_pools: true,
      site_only: true,
    });
  });

  it("emphasizes instructor approval without changing eligibility", async () => {
    getClaimableMembershipPackages.mockResolvedValue([
      opportunity({
        package_id: "instructor-package",
        pool_name: "Instructor membership",
        requires_approval: true,
      }),
    ]);
    render(<Harness />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Request instructor access",
      }),
    );

    await waitFor(() =>
      expect(requestSiteLicensePool).toHaveBeenCalledWith({
        owner_account_id: "owner-1",
        package_id: "instructor-package",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("does not offer another pool after a seat from that site license is claimed", async () => {
    getClaimableMembershipPackages.mockResolvedValue([
      opportunity({
        assignment_id: "assignment-1",
        seat_status: "claimed",
      }),
      opportunity({
        package_id: "instructor-package",
        pool_name: "Instructor membership",
        requires_approval: true,
      }),
    ]);

    render(<Harness />);

    await waitFor(() =>
      expect(getClaimableMembershipPackages).toHaveBeenCalled(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refreshes stale data on return without polling active clients", async () => {
    const now = new Date("2026-08-29T12:00:00.000Z").getTime();
    const dateNow = jest.spyOn(Date, "now").mockReturnValue(now);
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "hidden",
    );
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    getClaimableMembershipPackages.mockResolvedValue([opportunity()]);

    try {
      render(<Harness />);
      await waitFor(() =>
        expect(getClaimableMembershipPackages).toHaveBeenCalledTimes(1),
      );

      fireEvent(document, new Event("visibilitychange"));
      expect(getClaimableMembershipPackages).toHaveBeenCalledTimes(1);

      dateNow.mockReturnValue(now + 16 * 60 * 1000);
      fireEvent(document, new Event("visibilitychange"));
      await waitFor(() =>
        expect(getClaimableMembershipPackages).toHaveBeenCalledTimes(2),
      );
    } finally {
      dateNow.mockRestore();
      if (hiddenDescriptor) {
        Object.defineProperty(document, "hidden", hiddenDescriptor);
      } else {
        delete (document as { hidden?: boolean }).hidden;
      }
    }
  });

  it("emphasizes the likely choice and opens the shared manager for alternatives", async () => {
    getClaimableMembershipPackages.mockResolvedValue([
      opportunity(),
      opportunity({ package_id: "package-2", pool_name: "Instructor" }),
    ]);
    render(<Harness />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Other membership options",
      }),
    );

    expect(
      await screen.findByText("Site-only membership manager"),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("supports temporary and permanent dismissal", async () => {
    getClaimableMembershipPackages.mockResolvedValue([opportunity()]);
    const first = render(<Harness />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Remind me in 7 days" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    first.unmount();

    localStorage.clear();
    render(<Harness />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Don't show these offers",
      }),
    );
    expect(setOtherSettings).toHaveBeenCalledWith(
      "site_license_reminder_dismissals",
      { "site-1": expect.any(Number) },
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("site-license course role hints", () => {
  it("recognizes only non-hidden student course projects", () => {
    const projects = Map({
      hidden: Map({
        course: Map({ type: "student" }),
        users: Map({ "account-1": Map({ hide: true }) }),
      }),
      visible: Map({
        course: Map({ type: "student" }),
        users: Map({ "account-1": Map({ hide: false }) }),
      }),
    });
    expect(
      hasVisibleStudentCourseProject({
        accountId: "account-1",
        projectMap: projects,
      }),
    ).toBe(true);
  });

  it("uses role evidence only to order already-claimable pools", () => {
    const student = opportunity({ package_id: "student" });
    const instructor = opportunity({
      package_id: "instructor",
      pool_name: "Instructor membership",
      requires_approval: true,
    });
    expect(
      sortSiteLicenseOpportunities([student, instructor], "instructor")[0]
        .package_id,
    ).toBe("instructor");
    expect(
      sortSiteLicenseOpportunities([instructor, student], "student")[0]
        .package_id,
    ).toBe("student");
  });
});
