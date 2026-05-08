import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  ClaimableMembershipPackagesPanel,
  MembershipPackageManager,
} from "../membership-package-manager";

const getMembershipPackages = jest.fn();
const getClaimableMembershipPackages = jest.fn();
const claimMembershipPackageSeat = jest.fn();
const getMembershipPackageQuote = jest.fn();
const isPurchaseAllowed = jest.fn();
const purchaseMembershipPackage = jest.fn();
const processPaymentIntents = jest.fn();
const assignMembershipPackageSeat = jest.fn();
const revokeMembershipPackageSeat = jest.fn();
const userSearch = jest.fn();
const getNames = jest.fn();

let accountId = "owner-1";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => accountId,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Loading: () => <div>loading</div>,
}));

jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: () => <span>time-ago</span>,
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
  getMembershipPackageQuote: (...args: any[]) =>
    getMembershipPackageQuote(...args),
  isPurchaseAllowed: (...args: any[]) => isPurchaseAllowed(...args),
  purchaseMembershipPackage: (...args: any[]) =>
    purchaseMembershipPackage(...args),
  processPaymentIntents: (...args: any[]) => processPaymentIntents(...args),
  assignMembershipPackageSeat: (...args: any[]) =>
    assignMembershipPackageSeat(...args),
  revokeMembershipPackageSeat: (...args: any[]) =>
    revokeMembershipPackageSeat(...args),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
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
  });

  beforeEach(() => {
    jest.clearAllMocks();
    accountId = "owner-1";
    getClaimableMembershipPackages.mockResolvedValue([]);
    processPaymentIntents.mockResolvedValue({ count: 0 });
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
        screen.getByPlaceholderText("Search by name or exact email address"),
      ).toBeTruthy();
    });

    fireEvent.change(
      screen.getByPlaceholderText("Search by name or exact email address"),
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
      screen.getByPlaceholderText("Search by name or exact email address"),
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
        screen.getByText(/Verified domain match via ada@example.edu/i),
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
});
