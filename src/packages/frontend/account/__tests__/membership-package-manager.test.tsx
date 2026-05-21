import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  ClaimableMembershipPackagesPanel,
  MembershipPackageManager,
} from "../membership-package-manager";

const getMembershipPackages = jest.fn();
const getClaimableMembershipPackages = jest.fn();
const claimMembershipPackageSeat = jest.fn();
const requestSiteLicensePool = jest.fn();
const getSiteLicenseOverview = jest.fn();
const reviewSiteLicensePoolRequest = jest.fn();
const getMembershipPackageQuote = jest.fn();
const isPurchaseAllowed = jest.fn();
const purchaseMembershipPackage = jest.fn();
const processPaymentIntents = jest.fn();
const adminProvisionSiteLicense = jest.fn();
const adminProvisionMembershipPackage = jest.fn();
const updateMembershipPackage = jest.fn();
const assignMembershipPackageSeat = jest.fn();
const revokeMembershipPackageSeat = jest.fn();
const getSiteLicenseAffiliationReverificationStatus = jest.fn();
const refreshSiteLicenseAffiliationVerification = jest.fn();
const userSearch = jest.fn();
const getNames = jest.fn();
const runFreshAuthAction = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});

let accountId = "owner-1";
let isAdmin = false;

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (_store: string, key: string) =>
    key === "is_admin" ? isAdmin : accountId,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Loading: () => <div>loading</div>,
}));

jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: () => <span>time-ago</span>,
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => <div data-testid="fresh-auth-modal" />,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction,
  }),
}));

jest.mock("@cocalc/frontend/purchases/money-statistic", () => (props: any) => (
  <div>{`${props.title}: ${props.value}`}</div>
));

jest.mock("@cocalc/frontend/purchases/payments", () => () => (
  <div>payments</div>
));

jest.mock("@cocalc/frontend/purchases/stripe-payment", () => (props: any) => (
  <button type="button" onClick={() => props.onFinished(0)}>
    complete-payment
  </button>
));

jest.mock("@cocalc/frontend/purchases/api", () => ({
  getMembershipPackages: (...args: any[]) => getMembershipPackages(...args),
  getClaimableMembershipPackages: (...args: any[]) =>
    getClaimableMembershipPackages(...args),
  claimMembershipPackageSeat: (...args: any[]) =>
    claimMembershipPackageSeat(...args),
  requestSiteLicensePool: (...args: any[]) => requestSiteLicensePool(...args),
  getSiteLicenseOverview: (...args: any[]) => getSiteLicenseOverview(...args),
  reviewSiteLicensePoolRequest: (...args: any[]) =>
    reviewSiteLicensePoolRequest(...args),
  getMembershipPackageQuote: (...args: any[]) =>
    getMembershipPackageQuote(...args),
  isPurchaseAllowed: (...args: any[]) => isPurchaseAllowed(...args),
  purchaseMembershipPackage: (...args: any[]) =>
    purchaseMembershipPackage(...args),
  processPaymentIntents: (...args: any[]) => processPaymentIntents(...args),
  adminProvisionSiteLicense: (...args: any[]) =>
    adminProvisionSiteLicense(...args),
  adminProvisionMembershipPackage: (...args: any[]) =>
    adminProvisionMembershipPackage(...args),
  updateMembershipPackage: (...args: any[]) => updateMembershipPackage(...args),
  assignMembershipPackageSeat: (...args: any[]) =>
    assignMembershipPackageSeat(...args),
  revokeMembershipPackageSeat: (...args: any[]) =>
    revokeMembershipPackageSeat(...args),
  getSiteLicenseAffiliationReverificationStatus: (...args: any[]) =>
    getSiteLicenseAffiliationReverificationStatus(...args),
  refreshSiteLicenseAffiliationVerification: (...args: any[]) =>
    refreshSiteLicenseAffiliationVerification(...args),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    users_client: {
      user_search: (...args: any[]) => userSearch(...args),
      getNames: (...args: any[]) => getNames(...args),
    },
  },
}));

const TIERS = [
  { id: "member", label: "Member", store_visible: true },
  { id: "pro", label: "Pro", store_visible: true },
  { id: "student", label: "Student", store_visible: false },
];

describe("MembershipPackageManager", () => {
  beforeAll(() => {
    Object.defineProperty(window, "getComputedStyle", {
      configurable: true,
      value: () =>
        ({
          getPropertyValue: () => "",
        }) as CSSStyleDeclaration,
    });
    class TestMessageChannel {
      port1: {
        onmessage: ((event: MessageEvent) => void) | null;
        close: () => void;
      };
      port2: { postMessage: (data?: unknown) => void; close: () => void };

      constructor() {
        this.port1 = {
          onmessage: null,
          close: () => undefined,
        };
        this.port2 = {
          postMessage: (data?: unknown) => {
            setTimeout(() => {
              this.port1.onmessage?.({ data } as MessageEvent);
            }, 0);
          },
          close: () => undefined,
        };
      }
    }
    Object.defineProperty(global, "MessageChannel", {
      configurable: true,
      value: TestMessageChannel,
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    accountId = "owner-1";
    isAdmin = false;
    getClaimableMembershipPackages.mockResolvedValue([]);
    processPaymentIntents.mockResolvedValue({ count: 0 });
    runFreshAuthAction.mockClear();
    getNames.mockResolvedValue({
      "user-1": { first_name: "Grace", last_name: "Hopper" },
    });
  });

  it("renders team and site package sections", async () => {
    getMembershipPackages.mockResolvedValue([
      {
        id: "team-1",
        owner_account_id: "owner-1",
        kind: "team",
        membership_class: "member",
        seat_count: 5,
        active_assignment_count: 1,
        available_seat_count: 4,
        assignments: [
          {
            id: "assignment-1",
            package_id: "team-1",
            account_id: "user-1",
            assigned_at: new Date("2026-05-01T00:00:00Z"),
          },
        ],
        metadata: { interval: "month", seat_price: 10 },
      },
      {
        id: "site-1",
        owner_account_id: "owner-1",
        kind: "site",
        membership_class: "pro",
        seat_count: 50,
        active_assignment_count: 0,
        available_seat_count: 50,
        assignments: [],
        metadata: { allowed_domains: ["example.edu"] },
      },
    ]);

    render(<MembershipPackageManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Team packages")).toBeTruthy();
      expect(screen.getByText("Site licenses")).toBeTruthy();
      expect(screen.getByText("example.edu")).toBeTruthy();
      expect(screen.getByText("Grace Hopper")).toBeTruthy();
    });
  });

  it("purchases a new team package", async () => {
    getMembershipPackages.mockResolvedValue([]);
    getMembershipPackageQuote.mockResolvedValue({
      kind: "team",
      membership_class: "member",
      seat_count: 1,
      seat_price: 10,
      total_price: 10,
      interval: "month",
    });
    isPurchaseAllowed.mockResolvedValue({ allowed: true, chargeAmount: 10 });
    purchaseMembershipPackage.mockResolvedValue({
      package_id: "team-1",
      purchase_id: 1,
    });

    render(<MembershipPackageManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Buy team seats")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Buy team seats"));

    await waitFor(() => {
      expect(screen.getByText("Purchase team seats")).toBeTruthy();
      expect(screen.getByText("complete-payment")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("complete-payment"));

    await waitFor(() => {
      expect(purchaseMembershipPackage).toHaveBeenCalledWith({
        kind: "team",
        membership_class: "member",
        seat_count: 1,
        interval: "month",
      });
      expect(screen.getByText("Team seats purchased")).toBeTruthy();
    });
  });

  it("shows seats after purchase as a plain count when adding team seats", async () => {
    getMembershipPackages.mockResolvedValue([
      {
        id: "team-1",
        owner_account_id: "owner-1",
        kind: "team",
        membership_class: "member",
        seat_count: 5,
        active_assignment_count: 0,
        available_seat_count: 5,
        assignments: [],
        metadata: { interval: "month", seat_price: 10 },
      },
    ]);
    getMembershipPackageQuote.mockResolvedValue({
      kind: "team",
      membership_class: "member",
      seat_count: 1,
      seat_price: 10,
      total_price: 10,
      interval: "month",
    });
    isPurchaseAllowed.mockResolvedValue({ allowed: true, chargeAmount: 10 });

    render(<MembershipPackageManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Add seats")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Add seats"));

    await waitFor(() => {
      expect(screen.getByText("Seats after purchase")).toBeTruthy();
      expect(screen.getByText("6")).toBeTruthy();
    });
    expect(screen.queryByText("Seats after purchase: 6")).toBeNull();
  });

  it("assigns a seat from an existing package", async () => {
    getMembershipPackages.mockResolvedValue([
      {
        id: "team-1",
        owner_account_id: "owner-1",
        kind: "team",
        membership_class: "member",
        seat_count: 5,
        active_assignment_count: 0,
        available_seat_count: 5,
        assignments: [],
        metadata: { interval: "month", seat_price: 10 },
      },
    ]);
    userSearch.mockResolvedValue([
      {
        account_id: "user-2",
        first_name: "Ada",
        last_name: "Lovelace",
        email_address: "ada@example.com",
      },
    ]);
    assignMembershipPackageSeat.mockResolvedValue({
      id: "assignment-1",
      package_id: "team-1",
      account_id: "user-2",
      assigned_at: new Date(),
    });

    render(<MembershipPackageManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getAllByText("Assign seat").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByText("Assign seat")[0]);

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Search by name or enter an email address"),
      ).toBeTruthy();
    });

    fireEvent.change(
      screen.getByPlaceholderText("Search by name or enter an email address"),
      { target: { value: "ada@example.com" } },
    );
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => {
      expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    });

    fireEvent.click(screen.getAllByText("Assign seat")[1]);

    await waitFor(() => {
      expect(assignMembershipPackageSeat).toHaveBeenCalledWith({
        package_id: "team-1",
        target_account_id: "user-2",
      });
    });
  });

  it("reserves a seat by email when no account exists yet", async () => {
    getMembershipPackages.mockResolvedValue([
      {
        id: "team-1",
        owner_account_id: "owner-1",
        kind: "team",
        membership_class: "member",
        seat_count: 5,
        active_assignment_count: 0,
        available_seat_count: 5,
        assignments: [],
        metadata: { interval: "month", seat_price: 10 },
      },
    ]);
    userSearch.mockResolvedValue([]);
    assignMembershipPackageSeat.mockResolvedValue({
      id: "assignment-2",
      package_id: "team-1",
      email_address: "newuser@example.com",
      assigned_at: new Date(),
    });

    render(<MembershipPackageManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getAllByText("Assign seat").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByText("Assign seat")[0]);
    fireEvent.change(
      screen.getByPlaceholderText("Search by name or enter an email address"),
      { target: { value: "newuser@example.com" } },
    );
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => {
      expect(
        screen.getByText(
          /Reserve this seat by email until the user verifies it/i,
        ),
      ).toBeTruthy();
    });

    fireEvent.click(screen.getAllByText("Assign seat")[1]);

    await waitFor(() => {
      expect(assignMembershipPackageSeat).toHaveBeenCalledWith({
        package_id: "team-1",
        target_email_address: "newuser@example.com",
      });
    });
  });

  it("lets admins provision a site license without payment", async () => {
    isAdmin = true;
    getMembershipPackages.mockResolvedValue([]);
    adminProvisionSiteLicense.mockResolvedValue({
      site_license: {
        id: "license-1",
        name: "Campus site license",
        organization_name: "Example University",
        owner_account_id: "owner-1",
        allowed_domains: ["example.edu"],
      },
      pools: [],
      managers: [],
      pending_requests: [],
    });

    render(<MembershipPackageManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Provision site license")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Provision site license"));

    await waitFor(() => {
      expect(screen.getByText(/real site license/i)).toBeTruthy();
    });

    const domainInput = screen.getByLabelText("Allowed email domains");
    fireEvent.change(domainInput, {
      target: { value: "example.edu, dept.example.edu" },
    });
    fireEvent.click(screen.getByText("Provision license"));

    await waitFor(() => {
      expect(runFreshAuthAction).toHaveBeenCalledTimes(1);
      expect(adminProvisionSiteLicense).toHaveBeenCalledWith({
        owner_account_id: undefined,
        allowed_domains: ["dept.example.edu", "example.edu"],
        name: "Campus site license",
        organization_name: "Example University",
        custom_terms_url: null,
        custom_policy_url: null,
        terms_version_label: null,
        renewal_policy: "annual",
        overage_policy: "hard-cap",
        starts_at: undefined,
        expires_at: undefined,
        pools: expect.arrayContaining([
          expect.objectContaining({
            pool_name: "Students",
            requires_approval: false,
            allowed_domains: ["dept.example.edu", "example.edu"],
          }),
          expect.objectContaining({
            pool_name: "Instructors",
            requires_approval: true,
            allowed_domains: ["dept.example.edu", "example.edu"],
          }),
          expect.objectContaining({
            pool_name: "Researchers",
            requires_approval: true,
            allowed_domains: ["dept.example.edu", "example.edu"],
          }),
        ]),
      });
    });
  });

  it("lets admins update a site license seat count and allowed domains", async () => {
    isAdmin = true;
    getMembershipPackages.mockResolvedValue([
      {
        id: "site-1",
        owner_account_id: "owner-1",
        kind: "site",
        membership_class: "pro",
        seat_count: 50,
        active_assignment_count: 2,
        available_seat_count: 48,
        assignments: [],
        metadata: { allowed_domains: ["example.edu"] },
      },
    ]);
    updateMembershipPackage.mockResolvedValue({
      id: "site-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "pro",
      seat_count: 75,
      active_assignment_count: 2,
      available_seat_count: 73,
      assignments: [],
      metadata: { allowed_domains: ["example.edu"] },
    });

    render(<MembershipPackageManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Edit license")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Edit license"));
    const seats = await screen.findByDisplayValue("50");
    fireEvent.change(seats, { target: { value: "75" } });
    const domainInput = screen.getAllByRole("combobox")[0];
    fireEvent.change(domainInput!, {
      target: { value: "Example.EDU, dept.example.edu" },
    });
    fireEvent.blur(domainInput!);
    fireEvent.click(screen.getByText("Save license"));

    await waitFor(() => {
      expect(updateMembershipPackage).toHaveBeenCalledWith({
        package_id: "site-1",
        owner_account_id: "owner-1",
        seat_count: 75,
        allowed_domains: ["dept.example.edu", "example.edu"],
        expires_at: null,
      });
    });
  });
});

describe("ClaimableMembershipPackagesPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    accountId = "account-1";
  });

  it("claims a package for the signed-in account", async () => {
    getClaimableMembershipPackages.mockResolvedValue([
      {
        package_id: "site-1",
        kind: "site",
        membership_class: "member",
        owner_account_id: "owner-1",
        available_seat_count: 3,
        matched_email_address: "ada@example.edu",
        reason: "domain-match",
      },
    ]);
    claimMembershipPackageSeat.mockResolvedValue({
      id: "assignment-1",
      package_id: "site-1",
      account_id: "account-1",
    });

    render(<ClaimableMembershipPackagesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Claim memberships")).toBeTruthy();
      expect(
        screen.getByText(
          /Verified domain match for site-license pool via ada@example.edu/i,
        ),
      ).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Claim seat"));

    await waitFor(() => {
      expect(claimMembershipPackageSeat).toHaveBeenCalledWith({
        package_id: "site-1",
      });
      expect(getClaimableMembershipPackages).toHaveBeenCalledTimes(2);
    });
  });

  it("requests manager approval for an approval-required site-license pool", async () => {
    getClaimableMembershipPackages.mockResolvedValue([
      {
        package_id: "instructor-pool-1",
        kind: "site",
        membership_class: "pro",
        owner_account_id: "owner-1",
        available_seat_count: 3,
        matched_email_address: "ada@example.edu",
        reason: "domain-match",
        requires_approval: true,
        pool_name: "Instructors",
      },
    ]);
    requestSiteLicensePool.mockResolvedValue({
      id: "request-1",
      package_id: "instructor-pool-1",
      account_id: "account-1",
      state: "pending",
    });

    render(<ClaimableMembershipPackagesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Request access")).toBeTruthy();
      expect(screen.getByText("Manager approval required")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Request access"));

    await waitFor(() => {
      expect(requestSiteLicensePool).toHaveBeenCalledWith({
        owner_account_id: "owner-1",
        package_id: "instructor-pool-1",
      });
      expect(claimMembershipPackageSeat).not.toHaveBeenCalled();
    });
  });

  it("requires custom terms confirmation before claiming a site-license pool", async () => {
    getClaimableMembershipPackages.mockResolvedValue([
      {
        package_id: "site-terms-1",
        kind: "site",
        membership_class: "member",
        owner_account_id: "owner-1",
        available_seat_count: 3,
        matched_email_address: "ada@example.edu",
        reason: "domain-match",
        requires_terms_acceptance: true,
        custom_terms_url: "https://example.edu/terms",
        custom_policy_url: "https://example.edu/policy",
        terms_version_label: "2026 pilot",
      },
    ]);
    claimMembershipPackageSeat.mockResolvedValue({
      id: "assignment-1",
      package_id: "site-terms-1",
      account_id: "account-1",
    });

    render(<ClaimableMembershipPackagesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Review required")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Claim seat"));

    await waitFor(() => {
      expect(screen.getByText("Custom terms of service")).toBeTruthy();
      expect(screen.getByText("Institution policy")).toBeTruthy();
      expect(screen.getByText("Terms version: 2026 pilot")).toBeTruthy();
    });
    expect(claimMembershipPackageSeat).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByText(/I have reviewed the institution terms and policies/i),
    );
    const claimButtons = screen.getAllByText("Claim seat");
    fireEvent.click(claimButtons[claimButtons.length - 1]);

    await waitFor(() => {
      expect(claimMembershipPackageSeat).toHaveBeenCalledWith({
        package_id: "site-terms-1",
        accepted_terms: true,
      });
    });
  });
});
