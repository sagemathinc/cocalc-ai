import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import {
  ClaimableMembershipPackagesPanel,
  SiteLicenseManager,
  SiteLicenseAdminPanel,
  TeamPackageManager,
} from "../membership-package-manager";

const getClaimableMembershipPackages = jest.fn();
const claimMembershipPackageSeat = jest.fn();
const requestSiteLicensePool = jest.fn();
const cancelSiteLicensePoolRequest = jest.fn();
const releaseSiteLicensePoolSeat = jest.fn();
const getSiteLicenseOverview = jest.fn();
const listSiteLicenseOverviews = jest.fn();
const reviewSiteLicensePoolRequest = jest.fn();
const getTeamLicense = jest.fn();
const getTeamLicenseQuote = jest.fn();
const purchaseTeamLicenseChange = jest.fn();
const processPaymentIntents = jest.fn();
const adminProvisionSiteLicense = jest.fn();
const addSiteLicensePool = jest.fn();
const archiveSiteLicensePool = jest.fn();
const updateSiteLicense = jest.fn();
const setSiteLicenseManager = jest.fn();
const removeSiteLicenseManager = jest.fn();
const updateMembershipPackage = jest.fn();
const assignMembershipPackageSeat = jest.fn();
const revokeMembershipPackageSeat = jest.fn();
const userSearch = jest.fn();
const getNames = jest.fn();
const runFreshAuthAction = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});
const sendVerificationEmail = jest.fn();

let accountId = "owner-1";
let emailAddress = "ada@example.edu";
let emailVerified = true;
let isAdmin = false;

function emailAddressVerified() {
  return {
    get: (address: string) => emailVerified && address === emailAddress,
  };
}

function getSiteLicenseSummaryRow(name: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find(
      (row) =>
        row.getAttribute("data-site-license-id") != null &&
        row.querySelectorAll("td").length > 1 &&
        within(row).queryByText(name),
    );
  if (row == null) {
    throw Error(`unable to find site license summary row for ${name}`);
  }
  return row;
}

function expectTextNotVisible(text: string): void {
  const element = screen.queryByText(text);
  if (element != null) {
    expect(element).not.toBeVisible();
  }
}

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (_store: string, key: string) => {
    switch (key) {
      case "account_id":
        return accountId;
      case "email_address":
        return emailAddress;
      case "email_address_verified":
        return emailAddressVerified();
      case "is_admin":
        return isAdmin;
      default:
        return accountId;
    }
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Loading: () => <div>loading</div>,
  Tooltip: ({ children }: any) => children,
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
  <div>
    {(props.lineItems ?? []).map((item: any) => (
      <div key={item.description}>{item.description}</div>
    ))}
    <button type="button" onClick={() => props.onFinished(0)}>
      complete-payment
    </button>
  </div>
));

jest.mock("@cocalc/frontend/purchases/api", () => ({
  getClaimableMembershipPackages: (...args: any[]) =>
    getClaimableMembershipPackages(...args),
  claimMembershipPackageSeat: (...args: any[]) =>
    claimMembershipPackageSeat(...args),
  requestSiteLicensePool: (...args: any[]) => requestSiteLicensePool(...args),
  cancelSiteLicensePoolRequest: (...args: any[]) =>
    cancelSiteLicensePoolRequest(...args),
  releaseSiteLicensePoolSeat: (...args: any[]) =>
    releaseSiteLicensePoolSeat(...args),
  getSiteLicenseOverview: (...args: any[]) => getSiteLicenseOverview(...args),
  listSiteLicenseOverviews: (...args: any[]) =>
    listSiteLicenseOverviews(...args),
  reviewSiteLicensePoolRequest: (...args: any[]) =>
    reviewSiteLicensePoolRequest(...args),
  getTeamLicense: (...args: any[]) => getTeamLicense(...args),
  getTeamLicenseQuote: (...args: any[]) => getTeamLicenseQuote(...args),
  purchaseTeamLicenseChange: (...args: any[]) =>
    purchaseTeamLicenseChange(...args),
  processPaymentIntents: (...args: any[]) => processPaymentIntents(...args),
  adminProvisionSiteLicense: (...args: any[]) =>
    adminProvisionSiteLicense(...args),
  addSiteLicensePool: (...args: any[]) => addSiteLicensePool(...args),
  archiveSiteLicensePool: (...args: any[]) => archiveSiteLicensePool(...args),
  updateSiteLicense: (...args: any[]) => updateSiteLicense(...args),
  setSiteLicenseManager: (...args: any[]) => setSiteLicenseManager(...args),
  removeSiteLicenseManager: (...args: any[]) =>
    removeSiteLicenseManager(...args),
  updateMembershipPackage: (...args: any[]) => updateMembershipPackage(...args),
  assignMembershipPackageSeat: (...args: any[]) =>
    assignMembershipPackageSeat(...args),
  revokeMembershipPackageSeat: (...args: any[]) =>
    revokeMembershipPackageSeat(...args),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_client: {
      send_verification_email: (...args: any[]) =>
        sendVerificationEmail(...args),
    },
    browser_id: "browser-1",
    users_client: {
      user_search: (...args: any[]) => userSearch(...args),
      getNames: (...args: any[]) => getNames(...args),
    },
    conat_client: {
      hub: {
        system: {},
      },
    },
  },
}));

const TIERS = [
  {
    id: "member",
    label: "Member",
    site_license_pool_description: "Member site-license pool access.",
    store_visible: true,
    team_visible: true,
  },
  {
    id: "pro",
    label: "Pro",
    site_license_pool_description: "Pro site-license pool access.",
    store_visible: true,
    team_visible: true,
  },
];

function makeSitePackage(patch: Record<string, any> = {}) {
  return {
    id: "site-1",
    owner_account_id: "owner-1",
    kind: "site",
    membership_class: "pro",
    seat_count: 50,
    active_assignment_count: 0,
    available_seat_count: 50,
    assignments: [],
    metadata: {
      allowed_domains: ["example.edu"],
      pool_name: "Students",
      site_license_id: "license-1",
      requires_approval: false,
      verification_policy: "email-domain",
      exclusive_group: "student",
    },
    pool_name: "Students",
    requires_approval: false,
    verification_policy: "email-domain",
    exclusive_group: "student",
    pending_request_count: 0,
    ...patch,
  };
}

function makeTeamPackage(patch: Record<string, any> = {}) {
  return {
    id: "team-1",
    owner_account_id: "owner-1",
    kind: "team",
    membership_class: "member",
    seat_count: 5,
    active_assignment_count: 0,
    available_seat_count: 5,
    assignments: [],
    metadata: { interval: "year", seat_price: 10 },
    ...patch,
  };
}

function makeTeamLicenseOverview(packages: any[]) {
  return {
    id: "team-license-1",
    owner_account_id: "owner-1",
    status: "active",
    current_period_start: new Date("2026-06-01T00:00:00Z"),
    current_period_end: new Date("2027-06-01T00:00:00Z"),
    seat_lines: packages.map((membershipPackage) => ({
      id: `line-${membershipPackage.id}`,
      team_license_id: "team-license-1",
      owner_account_id: membershipPackage.owner_account_id,
      membership_class: membershipPackage.membership_class,
      package_id: membershipPackage.id,
      seat_count: membershipPackage.seat_count,
      annual_price_per_seat: Number(
        membershipPackage.metadata?.seat_price ?? 0,
      ),
      package: membershipPackage,
    })),
    packages,
  };
}

function makeSiteLicenseOverview({
  account_details = {},
  managers = [
    {
      id: "manager-1",
      site_license_id: "license-1",
      account_id: "owner-1",
      role: "manager",
    },
  ],
  pending_requests = [],
  pools,
  recent_audit_events = [],
  site_license = {},
}: {
  account_details?: Record<string, any>;
  managers?: any[];
  pending_requests?: any[];
  pools?: any[];
  recent_audit_events?: any[];
  site_license?: Record<string, any>;
} = {}) {
  return {
    site_license: {
      id: "license-1",
      name: "Campus License",
      organization_name: "Example University",
      bay_id: "bay-0",
      owner_account_id: null,
      allowed_domains: ["example.edu"],
      metadata: {},
      ...site_license,
    },
    pools: pools ?? [makeSitePackage()],
    managers,
    pending_requests,
    recent_audit_events,
    account_details,
    viewer_role: "manager",
  };
}

describe("membership package managers", () => {
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
    emailAddress = "ada@example.edu";
    emailVerified = true;
    isAdmin = false;
    getClaimableMembershipPackages.mockResolvedValue([]);
    sendVerificationEmail.mockResolvedValue(undefined);
    listSiteLicenseOverviews.mockResolvedValue([]);
    getTeamLicense.mockResolvedValue(null);
    getTeamLicenseQuote.mockResolvedValue({
      current_period_start: new Date("2026-06-01T00:00:00Z"),
      current_period_end: new Date("2027-06-01T00:00:00Z"),
      target_seats: {},
      current_seats: {},
      assigned_seats: {},
      added_seats: {},
      line_items: [],
      total_price: 0,
      interval: "year",
    });
    purchaseTeamLicenseChange.mockResolvedValue(null);
    processPaymentIntents.mockResolvedValue({ count: 0 });
    runFreshAuthAction.mockClear();
    userSearch.mockResolvedValue([]);
    getNames.mockResolvedValue({
      "user-1": { first_name: "Grace", last_name: "Hopper" },
    });
  });

  it("renders team packages without loading site-license dashboards", async () => {
    getTeamLicense.mockResolvedValue(
      makeTeamLicenseOverview([
        makeTeamPackage({
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
        }),
      ]),
    );
    render(<TeamPackageManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Team packages")).toBeTruthy();
      expect(screen.getByText("Grace Hopper")).toBeTruthy();
    });
    expect(listSiteLicenseOverviews).not.toHaveBeenCalled();
  });

  it("purchases a new team package", async () => {
    getTeamLicenseQuote.mockResolvedValue({
      current_period_start: new Date("2026-06-01T00:00:00Z"),
      current_period_end: new Date("2027-06-01T00:00:00Z"),
      target_seats: { member: 16, pro: 0 },
      current_seats: { member: 0, pro: 0 },
      assigned_seats: { member: 0, pro: 0 },
      added_seats: { member: 16, pro: 0 },
      line_items: [
        { description: "16 Member annual team seats at $10/seat", amount: 160 },
      ],
      total_price: 160,
      interval: "year",
    });
    purchaseTeamLicenseChange.mockImplementation(async ({ target_seats }) =>
      makeTeamLicenseOverview([
        makeTeamPackage({
          seat_count: target_seats.member,
          available_seat_count: target_seats.member,
        }),
      ]),
    );
    getTeamLicense.mockResolvedValueOnce(null).mockResolvedValue(
      makeTeamLicenseOverview([
        makeTeamPackage({
          seat_count: 16,
          available_seat_count: 16,
        }),
      ]),
    );

    render(<TeamPackageManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Set up team license")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Set up team license"));

    await waitFor(() => {
      expect(screen.getAllByText("Set up team license").length).toBeGreaterThan(
        0,
      );
      expect(screen.getByText("Choose annual team seats.")).toBeTruthy();
    });

    const memberRow = screen
      .getAllByRole("row")
      .find((row) => within(row).queryByText("Member"));
    if (memberRow == null) {
      throw Error("Member row not found");
    }
    fireEvent.change(within(memberRow).getByRole("spinbutton"), {
      target: { value: "16" },
    });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => {
      expect(screen.getByText("complete-payment")).toBeTruthy();
      expect(
        screen.getByText(
          "These seats will become available now and renew on June 1, 2027.",
        ),
      ).toBeTruthy();
      expect(
        screen.getByText("16 Member annual team seats at $10/seat"),
      ).toBeTruthy();
    });

    fireEvent.click(screen.getByText("complete-payment"));

    await waitFor(() => {
      expect(getTeamLicenseQuote).toHaveBeenCalledWith({
        target_seats: expect.objectContaining({ member: 16, pro: 0 }),
      });
      expect(purchaseTeamLicenseChange).toHaveBeenCalledWith({
        target_seats: expect.objectContaining({ member: 16, pro: 0 }),
      });
      expect(screen.getByText("Team license updated")).toBeTruthy();
    });
  });

  it("initializes team license seat counts from existing packages", async () => {
    getTeamLicense.mockResolvedValue(
      makeTeamLicenseOverview([
        makeTeamPackage({
          seat_count: 5,
          active_assignment_count: 0,
          available_seat_count: 5,
          assignments: [],
        }),
      ]),
    );

    render(<TeamPackageManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Add seats")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Add seats"));

    const memberRow = await waitFor(() => {
      const row = screen
        .getAllByRole("row")
        .find((row) => within(row).queryByText("Member"));
      if (row == null) {
        throw Error("Member row not found");
      }
      return row;
    });
    expect(within(memberRow).getByRole("spinbutton")).toHaveValue("5");

    fireEvent.change(within(memberRow).getByRole("spinbutton"), {
      target: { value: "6" },
    });
    expect(within(memberRow).getByRole("spinbutton")).toHaveValue("6");

    fireEvent.change(within(memberRow).getByRole("spinbutton"), {
      target: { value: "3" },
    });
    fireEvent.blur(within(memberRow).getByRole("spinbutton"));
    expect(within(memberRow).getByRole("spinbutton")).toHaveValue("5");
  });

  it("assigns a seat from an existing package", async () => {
    getTeamLicense.mockResolvedValue(
      makeTeamLicenseOverview([
        makeTeamPackage({
          seat_count: 5,
          active_assignment_count: 0,
          available_seat_count: 5,
          assignments: [],
        }),
      ]),
    );
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

    render(<TeamPackageManager tiers={TIERS} />);

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
    getTeamLicense.mockResolvedValue(
      makeTeamLicenseOverview([
        makeTeamPackage({
          seat_count: 5,
          active_assignment_count: 0,
          available_seat_count: 5,
          assignments: [],
        }),
      ]),
    );
    userSearch.mockResolvedValue([]);
    assignMembershipPackageSeat.mockResolvedValue({
      id: "assignment-2",
      package_id: "team-1",
      email_address: "newuser@example.com",
      assigned_at: new Date(),
    });

    render(<TeamPackageManager tiers={TIERS} />);

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

  it("provisions an admin site license without a user-selected bay", async () => {
    isAdmin = true;
    listSiteLicenseOverviews.mockResolvedValue([]);
    adminProvisionSiteLicense.mockResolvedValue({
      site_license: {
        id: "license-1",
        name: "Campus site license",
        organization_name: "Example University",
        bay_id: "bay-0",
        owner_account_id: null,
        allowed_domains: ["example.edu"],
      },
      pools: [],
      managers: [],
      pending_requests: [],
    });

    render(<SiteLicenseAdminPanel tiers={TIERS} />);

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
      expect(runFreshAuthAction).toHaveBeenCalled();
      expect(adminProvisionSiteLicense).toHaveBeenCalled();
    });
    const provisionCall = adminProvisionSiteLicense.mock.calls[0]?.[0];
    expect(provisionCall.bay_id).toBeUndefined();
    expect(new Set(provisionCall.allowed_domains)).toEqual(
      new Set(["example.edu", "dept.example.edu"]),
    );
  });

  it("shows a compact admin site-license list before the selected dashboard", async () => {
    isAdmin = true;
    listSiteLicenseOverviews.mockResolvedValue([
      {
        site_license: {
          id: "license-1",
          name: "Campus License",
          organization_name: "Example University",
          bay_id: "bay-0",
          owner_account_id: null,
          allowed_domains: ["example.edu"],
          metadata: {},
        },
        pools: [
          {
            id: "site-1",
            owner_account_id: "owner-1",
            kind: "site",
            membership_class: "pro",
            seat_count: 10,
            active_assignment_count: 1,
            available_seat_count: 9,
            assignments: [
              {
                id: "assignment-1",
                package_id: "site-1",
                account_id: "user-1",
                assigned_at: new Date("2026-05-01T00:00:00Z"),
              },
            ],
            metadata: {
              pool_name: "Students",
              site_license_id: "license-1",
              requires_approval: false,
              verification_policy: "email-domain",
              exclusive_group: "student",
            },
            pool_name: "Students",
            requires_approval: false,
            verification_policy: "email-domain",
            exclusive_group: "student",
            pending_request_count: 0,
          },
        ],
        managers: [],
        pending_requests: [],
        recent_audit_events: [],
      },
      {
        site_license: {
          id: "license-2",
          name: "Research License",
          organization_name: "Research Institute",
          bay_id: "bay-1",
          owner_account_id: null,
          allowed_domains: ["research.example.edu"],
          metadata: {},
        },
        pools: [
          {
            id: "site-2",
            owner_account_id: "owner-1",
            kind: "site",
            membership_class: "pro",
            seat_count: 20,
            active_assignment_count: 3,
            available_seat_count: 17,
            assignments: [
              {
                id: "assignment-2",
                package_id: "site-2",
                account_id: "user-2",
                assigned_at: new Date("2026-05-01T00:00:00Z"),
              },
              {
                id: "assignment-3",
                package_id: "site-2",
                account_id: "user-3",
                assigned_at: new Date("2026-05-01T00:00:00Z"),
              },
              {
                id: "assignment-4",
                package_id: "site-2",
                account_id: "user-4",
                assigned_at: new Date("2026-05-01T00:00:00Z"),
              },
            ],
            metadata: {
              pool_name: "Researchers",
              site_license_id: "license-2",
              requires_approval: true,
              verification_policy: "manager-approval",
              exclusive_group: "research",
            },
            pool_name: "Researchers",
            requires_approval: true,
            verification_policy: "manager-approval",
            exclusive_group: "research",
            pending_request_count: 1,
          },
        ],
        managers: [],
        pending_requests: [
          {
            id: "request-1",
            site_license_id: "license-2",
            package_id: "site-2",
            account_id: "student-1",
            matched_email_address: "ada@research.example.edu",
            canonical_identity: "ada@research.example.edu",
            requested_membership_class: "pro",
            state: "pending",
            requested_at: new Date("2026-05-01T00:00:00Z"),
          },
        ],
        recent_audit_events: [],
      },
    ]);

    render(<SiteLicenseAdminPanel tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Showing 2 of 2")).toBeTruthy();
      expect(screen.getByText("1 / 10")).toBeTruthy();
      expect(screen.getByText("3 / 20")).toBeTruthy();
      expect(screen.queryByText("Students")).toBeNull();
      expect(screen.queryByText("Researchers")).toBeNull();
    });

    fireEvent.click(getSiteLicenseSummaryRow("Campus License"));

    await waitFor(() => {
      expect(screen.getByText("Students")).toBeVisible();
    });

    fireEvent.click(getSiteLicenseSummaryRow("Campus License"));

    await waitFor(() => {
      expectTextNotVisible("Students");
    });

    fireEvent.click(getSiteLicenseSummaryRow("Research License"));

    await waitFor(() => {
      expect(screen.getAllByText("Researchers").length).toBeGreaterThan(0);
      expectTextNotVisible("Students");
    });
  });

  it("lets admins revoke an active site-license pool seat", async () => {
    isAdmin = true;
    const activeOverview = {
      site_license: {
        id: "license-1",
        name: "Campus License",
        organization_name: "Example University",
        bay_id: "bay-0",
        owner_account_id: null,
        allowed_domains: ["example.edu"],
        metadata: {},
      },
      pools: [
        {
          id: "site-1",
          owner_account_id: "owner-1",
          kind: "site",
          membership_class: "pro",
          seat_count: 10,
          active_assignment_count: 1,
          available_seat_count: 9,
          assignments: [
            {
              id: "assignment-1",
              package_id: "site-1",
              account_id: "user-1",
              email_address: "grace@example.edu",
              assigned_at: new Date(2026, 4, 1),
            },
          ],
          metadata: {
            pool_name: "Students",
            site_license_id: "license-1",
            requires_approval: false,
            verification_policy: "email-domain",
            exclusive_group: "student",
          },
          pool_name: "Students",
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "student",
          pending_request_count: 0,
        },
      ],
      managers: [],
      pending_requests: [],
      recent_audit_events: [],
    };
    const emptyOverview = {
      ...activeOverview,
      pools: [
        {
          ...activeOverview.pools[0],
          active_assignment_count: 0,
          available_seat_count: 10,
          assignments: [],
        },
      ],
    };
    listSiteLicenseOverviews
      .mockResolvedValueOnce([activeOverview])
      .mockResolvedValueOnce([emptyOverview]);
    revokeMembershipPackageSeat.mockResolvedValue({ revoked: true });

    render(<SiteLicenseAdminPanel tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Campus License")).toBeTruthy();
    });

    fireEvent.click(getSiteLicenseSummaryRow("Campus License"));

    await waitFor(() => {
      expect(screen.getByText("Manage users")).toBeTruthy();
    });
    expect(screen.queryByText("Grace Hopper")).toBeNull();

    fireEvent.click(screen.getByText("Manage users"));

    await screen.findByText("Students users");
    expect(await screen.findByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText("grace@example.edu")).toBeTruthy();
    expect(screen.getByText("Seat given on")).toBeTruthy();
    expect(screen.getByText("May 1, 2026")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Search by name or email"), {
      target: { value: "nobody" },
    });
    expect(await screen.findByText("No users match this search.")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search by name or email"), {
      target: { value: "grace" },
    });
    expect(await screen.findByText("Grace Hopper")).toBeTruthy();

    fireEvent.click(screen.getByText("Revoke"));
    await screen.findByText(
      "Revoke the Students seat for Grace Hopper (grace@example.edu)?",
    );
    fireEvent.click(screen.getByText("Revoke seat"));

    await waitFor(() => {
      expect(revokeMembershipPackageSeat).toHaveBeenCalledWith({
        package_id: "site-1",
        target_account_id: "user-1",
        target_email_address: undefined,
      });
      expect(screen.getByText("No active users.")).toBeTruthy();
    });
  });

  it("lets admins archive an empty site-license pool", async () => {
    isAdmin = true;
    const activeOverview = {
      site_license: {
        id: "license-1",
        name: "Campus License",
        organization_name: "Example University",
        bay_id: "bay-0",
        owner_account_id: null,
        allowed_domains: ["example.edu"],
        metadata: {},
      },
      pools: [
        {
          id: "site-1",
          owner_account_id: "owner-1",
          kind: "site",
          membership_class: "pro",
          seat_count: 10,
          active_assignment_count: 0,
          available_seat_count: 10,
          assignments: [],
          metadata: {
            pool_name: "Students",
            site_license_id: "license-1",
            requires_approval: false,
            verification_policy: "email-domain",
            exclusive_group: "student",
          },
          pool_name: "Students",
          requires_approval: false,
          verification_policy: "email-domain",
          exclusive_group: "student",
          pending_request_count: 0,
        },
      ],
      managers: [],
      pending_requests: [],
      recent_audit_events: [],
    };
    listSiteLicenseOverviews
      .mockResolvedValueOnce([activeOverview])
      .mockResolvedValueOnce([{ ...activeOverview, pools: [] }]);
    archiveSiteLicensePool.mockResolvedValue({ ...activeOverview, pools: [] });

    render(<SiteLicenseAdminPanel tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Campus License")).toBeTruthy();
    });

    fireEvent.click(getSiteLicenseSummaryRow("Campus License"));

    await waitFor(() => {
      expect(screen.getByText("Students")).toBeTruthy();
    });

    const clickArchivePoolAction = () =>
      fireEvent.click(
        screen.getAllByRole("button", { name: /Archive pool/ })[0],
      );

    clickArchivePoolAction();

    await waitFor(() => {
      expect(screen.getByText("Archive Students?")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(archiveSiteLicensePool).not.toHaveBeenCalled();

    const archiveButtons = screen.getAllByRole("button", {
      name: /Archive pool/,
    });
    fireEvent.click(archiveButtons[archiveButtons.length - 1]);

    await waitFor(() => {
      expect(archiveSiteLicensePool).toHaveBeenCalledWith({
        package_id: "site-1",
      });
      expect(screen.queryByText("Manage users")).toBeNull();
    });
  });

  it("lets admins update a site-license pool from the dashboard", async () => {
    isAdmin = true;
    const sitePackage = {
      id: "site-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "pro",
      seat_count: 50,
      active_assignment_count: 2,
      available_seat_count: 48,
      assignments: [],
      metadata: {
        allowed_domains: ["example.edu"],
        pool_name: "Students",
        site_license_id: "license-1",
        requires_approval: false,
        verification_policy: "email-domain",
        exclusive_group: "student",
      },
      pool_name: "Students",
      requires_approval: false,
      verification_policy: "email-domain",
      exclusive_group: "student",
      pending_request_count: 0,
    };
    listSiteLicenseOverviews.mockResolvedValue([
      {
        site_license: {
          id: "license-1",
          name: "Campus License",
          organization_name: "Example University",
          bay_id: "bay-0",
          owner_account_id: null,
          allowed_domains: ["example.edu"],
          metadata: {},
        },
        pools: [sitePackage],
        managers: [],
        pending_requests: [],
        recent_audit_events: [],
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

    render(<SiteLicenseAdminPanel tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Campus License")).toBeTruthy();
    });

    fireEvent.click(getSiteLicenseSummaryRow("Campus License"));

    await waitFor(() => {
      expect(screen.getByText("Edit pool")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Edit pool"));
    const seats = await screen.findByDisplayValue("50");
    fireEvent.change(seats, { target: { value: "75" } });
    fireEvent.click(screen.getByText("Save pool"));

    await waitFor(() => {
      expect(updateMembershipPackage).toHaveBeenCalledWith({
        package_id: "site-1",
        owner_account_id: "owner-1",
        site_license_id: "license-1",
        pool_name: "Students",
        seat_count: 75,
        pool_description: null,
        requires_approval: false,
        affiliation_reverification_days: null,
        affiliation_reverification_grace_days: null,
        allowed_domains: ["example.edu"],
        expires_at: null,
      });
    });
  });

  it("hides site-license structural edit controls from non-admin managers", async () => {
    const sitePackage = {
      id: "site-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "pro",
      seat_count: 50,
      active_assignment_count: 2,
      available_seat_count: 48,
      assignments: [],
      metadata: {
        allowed_domains: ["example.edu"],
        pool_name: "Students",
        site_license_id: "license-1",
        requires_approval: false,
        verification_policy: "email-domain",
        exclusive_group: "student",
      },
      pool_name: "Students",
      requires_approval: false,
      verification_policy: "email-domain",
      exclusive_group: "student",
      pending_request_count: 0,
    };
    listSiteLicenseOverviews.mockResolvedValue([
      {
        site_license: {
          id: "license-1",
          name: "Campus License",
          organization_name: "Example University",
          bay_id: "bay-0",
          owner_account_id: null,
          allowed_domains: ["example.edu"],
          metadata: {},
        },
        pools: [sitePackage],
        account_details: {
          "owner-1": {
            account_id: "owner-1",
            first_name: "Olivia",
            last_name: "Owner",
            email_address: "owner@example.edu",
          },
        },
        managers: [
          {
            id: "manager-1",
            site_license_id: "license-1",
            account_id: "owner-1",
            role: "manager",
          },
        ],
        pending_requests: [],
        recent_audit_events: [],
      },
    ]);

    render(<SiteLicenseManager tiers={TIERS} />);

    await waitFor(() => {
      expect(
        screen.getByText("Campus License - Example University"),
      ).toBeTruthy();
    });

    expect(screen.queryByText("Site-license manager dashboard")).toBeNull();
    expect(screen.queryByText("Edit license")).toBeNull();
    expect(screen.queryByText("Edit pool")).toBeNull();
    expect(screen.queryByText("Add pool")).toBeNull();
    expect(screen.queryByText("Add delegate")).toBeNull();
    expect(screen.queryByText("Seat pools")).toBeNull();
    expect(screen.getByText("Olivia Owner")).toBeTruthy();
    expect(screen.getByText(/owner@example.edu/)).toBeTruthy();
    expect(screen.queryByText(/License id/)).toBeNull();
    expect(screen.queryByText(/seed bay/)).toBeNull();
    expect(
      screen.queryByText(
        "Only CoCalc admins can change delegated site-license roles.",
      ),
    ).toBeNull();
  });

  it("renders customer-facing site-license header details", async () => {
    listSiteLicenseOverviews.mockResolvedValue([
      makeSiteLicenseOverview({
        account_details: {
          "manager-1": {
            account_id: "manager-1",
            first_name: "Manny",
            last_name: "Manager",
            email_address: "manager@example.edu",
          },
          "student-1": {
            account_id: "student-1",
            first_name: "Ada",
            last_name: "Student",
            email_address: "student@example.edu",
          },
        },
        pending_requests: [
          {
            id: "request-1",
            site_license_id: "license-1",
            package_id: "site-1",
            account_id: "student-1",
            matched_email_address: "ada@greatplains.edu",
            canonical_identity: "ada@greatplains.edu",
            requested_membership_class: "pro",
            state: "pending",
            requested_at: new Date("2026-05-01T00:00:00Z"),
          },
        ],
        pools: [
          makeSitePackage({
            pending_request_count: 1,
            pool_description: "Research access for approved groups.",
          }),
        ],
        recent_audit_events: [
          {
            id: "event-1",
            site_license_id: "license-1",
            action: "pool-request-approved",
            actor_account_id: "manager-1",
            package_id: "site-1",
            target_account_id: "student-1",
            created: new Date("2026-05-02T00:00:00Z"),
          },
        ],
        site_license: {
          name: "CoCalc",
          organization_name: "University of Great Plains",
          allowed_domains: ["greatplains.edu"],
          starts_at: new Date(2099, 5, 5),
          expires_at: new Date(2099, 11, 31),
          renewal_policy: "annual",
          overage_policy: "hard-cap",
        },
      }),
    ]);

    render(<SiteLicenseManager tiers={TIERS} />);

    await waitFor(() => {
      expect(
        screen.getByText("CoCalc - University of Great Plains"),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(
        "Starts on June 5, 2099 · Valid until December 31, 2099",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Covered domains:")).toBeTruthy();
    expect(screen.getByText("greatplains.edu")).toBeTruthy();
    expect(screen.queryByText("Site license")).toBeNull();
    expect(screen.queryByText("University of Great Plains")).toBeNull();
    expect(screen.queryByText("1 pending requests")).toBeNull();
    expect(screen.queryByText(/renewal/i)).toBeNull();
    expect(screen.queryByText(/overage/i)).toBeNull();
    expect(
      screen.getByText("Research access for approved groups."),
    ).toBeTruthy();
    expect(screen.getByText(/Students pool request approved/)).toBeTruthy();
    expect(screen.getAllByText(/Ada Student/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/student@example.edu/).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(/Manny Manager/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/manager@example.edu/).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("Pro seats")).toBeNull();
  });

  it("renders approval requests compactly in oldest-first order", async () => {
    getNames.mockResolvedValue({
      "student-older": { first_name: "Ada", last_name: "Lovelace" },
      "student-newer": { first_name: "Grace", last_name: "Hopper" },
    });
    listSiteLicenseOverviews.mockResolvedValue([
      makeSiteLicenseOverview({
        pending_requests: [
          {
            id: "request-newer",
            site_license_id: "license-1",
            package_id: "instructor-pool",
            account_id: "student-newer",
            matched_email_address: "grace@example.edu",
            canonical_identity: "grace@example.edu",
            requested_membership_class: "pro",
            state: "pending",
            requested_at: new Date("2026-05-02T00:00:00Z"),
          },
          {
            id: "request-older",
            site_license_id: "license-1",
            package_id: "instructor-pool",
            account_id: "student-older",
            matched_email_address: "ada@example.edu",
            canonical_identity: "ada@example.edu",
            requested_membership_class: "pro",
            state: "pending",
            requested_at: new Date("2026-05-01T00:00:00Z"),
          },
        ],
        pools: [
          makeSitePackage({
            id: "instructor-pool",
            pool_name: "Instructor",
            pending_request_count: 2,
          }),
        ],
      }),
    ]);

    const { container } = render(<SiteLicenseManager tiers={TIERS} />);

    const older = await screen.findByText("Ada Lovelace");
    const newer = await screen.findByText("Grace Hopper");

    expect(container.textContent).toContain(
      "Ada Lovelace (ada@example.edu) requested Instructor seat time-ago",
    );
    expect(container.textContent).not.toContain("account student-older");
    expect(
      older.compareDocumentPosition(newer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("falls back to organization name when the license title is empty", async () => {
    listSiteLicenseOverviews.mockResolvedValue([
      makeSiteLicenseOverview({
        site_license: {
          name: "",
          organization_name: "Example University",
          allowed_domains: [],
        },
      }),
    ]);

    render(<SiteLicenseManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Example University")).toBeTruthy();
    });
    expect(screen.queryByText(" - Example University")).toBeNull();
    expect(screen.getByText("none configured")).toBeTruthy();
  });

  it("renders expired site licenses prominently without start dates", async () => {
    listSiteLicenseOverviews.mockResolvedValue([
      makeSiteLicenseOverview({
        site_license: {
          starts_at: new Date(2000, 0, 1),
          expires_at: new Date(2000, 5, 5),
        },
      }),
    ]);

    render(<SiteLicenseManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Expired on June 5, 2000")).toBeTruthy();
    });
    expect(screen.queryByText(/Starts on/)).toBeNull();
    expect(screen.queryByText(/Valid until/)).toBeNull();
  });

  it("uses the server-provided site-license viewer role for manager actions", async () => {
    const sitePackage = {
      id: "site-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "pro",
      seat_count: 50,
      active_assignment_count: 2,
      available_seat_count: 48,
      assignments: [],
      metadata: {
        allowed_domains: ["example.edu"],
        pool_name: "Instructors",
        site_license_id: "license-1",
        requires_approval: true,
        verification_policy: "email-domain",
        exclusive_group: "instructor",
      },
      pool_name: "Instructors",
      requires_approval: true,
      verification_policy: "email-domain",
      exclusive_group: "instructor",
      pending_request_count: 1,
    };
    listSiteLicenseOverviews.mockResolvedValue([
      {
        site_license: {
          id: "license-1",
          name: "Campus License",
          organization_name: "Example University",
          bay_id: "bay-0",
          owner_account_id: null,
          allowed_domains: ["example.edu"],
          metadata: {},
        },
        pools: [sitePackage],
        managers: [
          {
            id: "manager-1",
            site_license_id: "license-1",
            account_id: "another-account",
            role: "viewer",
          },
        ],
        pending_requests: [
          {
            id: "request-1",
            site_license_id: "license-1",
            package_id: "site-1",
            account_id: "student-1",
            matched_email_address: "ada@example.edu",
            canonical_identity: "ada@example.edu",
            requested_membership_class: "pro",
            state: "pending",
            requested_at: new Date("2026-05-01T00:00:00Z"),
          },
        ],
        recent_audit_events: [],
        viewer_role: "manager",
      },
    ]);
    reviewSiteLicensePoolRequest.mockResolvedValue({
      id: "request-1",
      state: "approved",
    });

    render(<SiteLicenseManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Approval queue")).toBeTruthy();
      expect(screen.getByText("Approve")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(reviewSiteLicensePoolRequest).toHaveBeenCalledWith({
        request_id: "request-1",
        action: "approve",
      });
    });
  });

  it("lets admins add site-license delegates with admin user search", async () => {
    isAdmin = true;
    const sitePackage = {
      id: "site-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "pro",
      seat_count: 50,
      active_assignment_count: 2,
      available_seat_count: 48,
      assignments: [],
      metadata: {
        allowed_domains: ["example.edu"],
        pool_name: "Students",
        site_license_id: "license-1",
        requires_approval: false,
        verification_policy: "email-domain",
      },
      pool_name: "Students",
      requires_approval: false,
      verification_policy: "email-domain",
      pending_request_count: 0,
    };
    userSearch.mockResolvedValue([
      {
        account_id: "manager-1",
        first_name: "Ada",
        last_name: "Lovelace",
        email_address: "ada@example.edu",
      },
    ]);
    setSiteLicenseManager.mockResolvedValue(undefined);
    listSiteLicenseOverviews.mockResolvedValue([
      {
        site_license: {
          id: "license-1",
          name: "Campus License",
          organization_name: "Example University",
          bay_id: "bay-0",
          owner_account_id: "owner-1",
          allowed_domains: ["example.edu"],
          metadata: {},
        },
        pools: [sitePackage],
        managers: [],
        pending_requests: [],
        recent_audit_events: [],
      },
    ]);

    render(<SiteLicenseAdminPanel tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Campus License")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Campus License"));
    const search = screen
      .getAllByRole("combobox")
      .find((element) => !element.hasAttribute("readonly"));
    if (search == null) {
      throw Error("missing delegate account search input");
    }
    fireEvent.change(search, { target: { value: "ada@example.edu" } });

    await waitFor(() => {
      expect(userSearch).toHaveBeenCalledWith({
        query: "ada@example.edu",
        limit: 20,
        admin: true,
      });
    });
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
  });

  it("confirms before removing a site-license manager", async () => {
    isAdmin = true;
    const overview = makeSiteLicenseOverview({
      managers: [
        {
          id: "manager-1",
          site_license_id: "license-1",
          account_id: "manager-1",
          role: "manager",
        },
      ],
    });
    listSiteLicenseOverviews
      .mockResolvedValueOnce([overview])
      .mockResolvedValueOnce([{ ...overview, managers: [] }]);
    removeSiteLicenseManager.mockResolvedValue(undefined);

    render(<SiteLicenseAdminPanel tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Campus License")).toBeTruthy();
    });

    fireEvent.click(getSiteLicenseSummaryRow("Campus License"));

    await waitFor(() => {
      expect(screen.getByText("manager-1")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(screen.getByText("Remove manager-1 as a manager?")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeSiteLicenseManager).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove manager" }));

    await waitFor(() => {
      expect(removeSiteLicenseManager).toHaveBeenCalledWith({
        site_license_id: "license-1",
        target_account_id: "manager-1",
      });
    });
  });

  it("requires fresh auth before reviewing site-license pool requests", async () => {
    const sitePackage = {
      id: "site-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "pro",
      seat_count: 50,
      active_assignment_count: 2,
      available_seat_count: 48,
      assignments: [],
      metadata: {
        allowed_domains: ["example.edu"],
        pool_name: "Instructors",
        site_license_id: "license-1",
        requires_approval: true,
        verification_policy: "email-domain",
        exclusive_group: "instructor",
      },
      pool_name: "Instructors",
      requires_approval: true,
      verification_policy: "email-domain",
      exclusive_group: "instructor",
      pending_request_count: 1,
    };
    listSiteLicenseOverviews.mockResolvedValue([
      {
        site_license: {
          id: "license-1",
          name: "Campus License",
          organization_name: "Example University",
          bay_id: "bay-0",
          owner_account_id: null,
          allowed_domains: ["example.edu"],
          metadata: {},
        },
        pools: [sitePackage],
        managers: [
          {
            id: "manager-1",
            account_id: "owner-1",
            role: "manager",
            site_license_id: "license-1",
          },
        ],
        pending_requests: [
          {
            id: "request-1",
            site_license_id: "license-1",
            package_id: "site-1",
            account_id: "student-1",
            matched_email_address: "ada@example.edu",
            canonical_identity: "ada@example.edu",
            requested_membership_class: "pro",
            state: "pending",
            requested_at: new Date("2026-05-01T00:00:00Z"),
          },
        ],
        recent_audit_events: [],
        viewer_role: "manager",
      },
    ]);
    reviewSiteLicensePoolRequest.mockResolvedValue({
      id: "request-1",
      state: "approved",
    });

    render(<SiteLicenseManager tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Approval queue")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(runFreshAuthAction).toHaveBeenCalledTimes(1);
      expect(reviewSiteLicensePoolRequest).toHaveBeenCalledWith({
        request_id: "request-1",
        action: "approve",
      });
    });
  });

  it("lets admins add a site-license pool from the dashboard", async () => {
    isAdmin = true;
    const sitePackage = {
      id: "site-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "member",
      seat_count: 50,
      active_assignment_count: 2,
      available_seat_count: 48,
      assignments: [],
      metadata: {
        allowed_domains: ["example.edu"],
        pool_name: "Students",
        site_license_id: "license-1",
        requires_approval: false,
        verification_policy: "email-domain",
        exclusive_group: "student",
      },
      pool_name: "Students",
      requires_approval: false,
      verification_policy: "email-domain",
      exclusive_group: "student",
      pending_request_count: 0,
    };
    listSiteLicenseOverviews.mockResolvedValue([
      {
        site_license: {
          id: "license-1",
          name: "Campus License",
          organization_name: "Example University",
          bay_id: "bay-0",
          owner_account_id: null,
          allowed_domains: ["example.edu"],
          metadata: {},
        },
        pools: [sitePackage],
        managers: [],
        pending_requests: [],
        recent_audit_events: [],
      },
    ]);
    addSiteLicensePool.mockResolvedValue({
      site_license: {
        id: "license-1",
        name: "Campus License",
        organization_name: "Example University",
        owner_account_id: "owner-1",
        allowed_domains: ["example.edu"],
        metadata: {},
      },
      pools: [],
      managers: [],
      pending_requests: [],
      recent_audit_events: [],
    });

    render(<SiteLicenseAdminPanel tiers={TIERS} />);

    await waitFor(() => {
      expect(screen.getByText("Campus License")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Campus License"));

    await waitFor(() => {
      expect(screen.getByText("Add pool")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Add pool"));
    const addPoolButtons = screen.getAllByText("Add pool");
    fireEvent.click(addPoolButtons[addPoolButtons.length - 1]);

    await waitFor(() => {
      expect(runFreshAuthAction).toHaveBeenCalledTimes(1);
      expect(addSiteLicensePool).toHaveBeenCalledWith({
        site_license_id: "license-1",
        pool: expect.objectContaining({
          pool_name: "Pool 2",
          pool_description: "Member site-license pool access.",
          membership_class: "member",
          seat_count: 25,
          requires_approval: true,
          verification_policy: "email-domain",
          exclusive_group: "group-2",
        }),
      });
    });
  });
});

describe("ClaimableMembershipPackagesPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    accountId = "account-1";
    emailAddress = "ada@example.edu";
    emailVerified = true;
    sendVerificationEmail.mockResolvedValue(undefined);
  });

  it("shows a resend verification callout when claiming is blocked by unverified email", async () => {
    emailVerified = false;
    getClaimableMembershipPackages.mockResolvedValue([]);

    render(<ClaimableMembershipPackagesPanel />);

    expect(
      await screen.findByText(
        "Verify your email to claim site-license memberships",
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Resend verification" }),
    );

    await waitFor(() => {
      expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText("Verification email sent to ada@example.edu."),
    ).toBeTruthy();
  });

  it("claims a package for the signed-in account", async () => {
    const onSiteLicenseTitleChange = jest.fn();
    getClaimableMembershipPackages.mockResolvedValue([
      {
        package_id: "site-1",
        kind: "site",
        membership_class: "member",
        owner_account_id: "owner-1",
        available_seat_count: 3,
        matched_email_address: "ada@example.edu",
        reason: "domain-match",
        pool_name: "Students",
        pool_description: "Access for eligible example.edu users.",
        site_license_name: "CoCalc Trial",
      },
    ]);
    claimMembershipPackageSeat.mockResolvedValue({
      id: "assignment-1",
      package_id: "site-1",
      account_id: "account-1",
    });

    render(
      <ClaimableMembershipPackagesPanel
        onSiteLicenseTitleChange={onSiteLicenseTitleChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Students")).toBeTruthy();
      expect(
        screen.getByText("Access for eligible example.edu users."),
      ).toBeTruthy();
    });
    expect(screen.queryByText("CoCalc Trial")).toBeNull();
    expect(screen.queryByText("Member")).toBeNull();
    expect(
      screen.queryByText("Tier default description should not show."),
    ).toBeNull();
    expect(screen.queryByText("More shared resources")).toBeNull();
    expect(screen.queryByText(/Verified domain match for/i)).toBeNull();
    expect(screen.queryByText(/via ada@example.edu/i)).toBeNull();
    expect(screen.queryByText("Available seats")).toBeNull();

    expect(screen.getByText("Claim seat")).not.toHaveClass("ant-btn-primary");

    fireEvent.click(screen.getByText("Claim seat"));

    await waitFor(() => {
      expect(claimMembershipPackageSeat).toHaveBeenCalledWith({
        package_id: "site-1",
      });
      expect(getClaimableMembershipPackages).toHaveBeenCalledTimes(2);
    });
    expect(onSiteLicenseTitleChange).toHaveBeenCalledWith("CoCalc Trial");
  });

  it("confirms before claiming a pool that replaces an active seat", async () => {
    getClaimableMembershipPackages.mockResolvedValue([
      {
        package_id: "student-pool-1",
        assignment_id: "assignment-1",
        kind: "site",
        membership_class: "member",
        owner_account_id: "owner-1",
        available_seat_count: 2,
        matched_email_address: "ada@example.edu",
        reason: "domain-match",
        site_license_id: "license-1",
        pool_name: "Student",
        seat_status: "claimed",
      },
      {
        package_id: "researcher-pool-1",
        kind: "site",
        membership_class: "pro",
        owner_account_id: "owner-1",
        available_seat_count: 2,
        matched_email_address: "ada@example.edu",
        reason: "domain-match",
        site_license_id: "license-1",
        pool_name: "Researcher",
      },
    ]);
    claimMembershipPackageSeat.mockResolvedValue({
      id: "assignment-2",
      package_id: "researcher-pool-1",
      account_id: "account-1",
    });

    render(<ClaimableMembershipPackagesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Student")).toBeTruthy();
      expect(screen.getByText("Researcher")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Claim seat" }));

    await screen.findByText("Replace current site-license seat?");
    expect(claimMembershipPackageSeat).not.toHaveBeenCalled();
    const claimButtons = screen.getAllByText("Claim seat");
    fireEvent.click(claimButtons[claimButtons.length - 1]);

    await waitFor(() => {
      expect(claimMembershipPackageSeat).toHaveBeenCalledWith({
        package_id: "researcher-pool-1",
      });
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
        pool_description: "Instructor access for approved faculty.",
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
      expect(screen.getByText("Instructors")).toBeTruthy();
      expect(screen.getByText("Request access")).toBeTruthy();
      expect(
        screen.getByText("Instructor access for approved faculty."),
      ).toBeTruthy();
    });
    expect(screen.queryByText("Pro")).toBeNull();
    expect(
      screen.queryByText("Tier default description should not show."),
    ).toBeNull();
    expect(screen.queryByText("Manager approval required")).toBeNull();
    expect(screen.queryByText("Approval")).toBeNull();
    expect(screen.getByText("Request access")).not.toHaveClass(
      "ant-btn-primary",
    );

    fireEvent.click(screen.getByText("Request access"));

    await waitFor(() => {
      expect(requestSiteLicensePool).toHaveBeenCalledWith({
        owner_account_id: "owner-1",
        package_id: "instructor-pool-1",
      });
      expect(claimMembershipPackageSeat).not.toHaveBeenCalled();
    });
  });

  it("releases an already claimed site-license pool after confirmation", async () => {
    getClaimableMembershipPackages.mockResolvedValue([
      {
        package_id: "student-pool-1",
        assignment_id: "assignment-1",
        kind: "site",
        membership_class: "member",
        owner_account_id: "owner-1",
        available_seat_count: 2,
        matched_email_address: "ada@example.edu",
        reason: "domain-match",
        pool_name: "Students",
        pool_description: "Student access for example.edu.",
        seat_status: "claimed",
      },
    ]);
    releaseSiteLicensePoolSeat.mockResolvedValue({ revoked: true });

    render(<ClaimableMembershipPackagesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Students")).toBeTruthy();
      expect(screen.getByText("Student access for example.edu.")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Release seat" }));
    await screen.findByText("Release Students seat?");
    const releaseButtons = screen.getAllByText("Release seat");
    fireEvent.click(releaseButtons[releaseButtons.length - 1]);

    await waitFor(() => {
      expect(releaseSiteLicensePoolSeat).toHaveBeenCalledWith({
        package_id: "student-pool-1",
      });
      expect(getClaimableMembershipPackages).toHaveBeenCalledTimes(2);
    });
    expect(claimMembershipPackageSeat).not.toHaveBeenCalled();
  });

  it("cancels a pending site-license pool request after confirmation", async () => {
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
        pool_description: "Instructor access for approved faculty.",
        pending_request_id: "request-1",
        pending_request_state: "pending",
      },
    ]);
    cancelSiteLicensePoolRequest.mockResolvedValue({
      id: "request-1",
      package_id: "instructor-pool-1",
      account_id: "account-1",
      state: "canceled",
    });

    render(<ClaimableMembershipPackagesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Instructors")).toBeTruthy();
      expect(screen.getByText("Cancel request")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await screen.findByText("Withdraw Instructors request?");
    fireEvent.click(screen.getByText("Withdraw request"));

    await waitFor(() => {
      expect(cancelSiteLicensePoolRequest).toHaveBeenCalledWith({
        request_id: "request-1",
      });
      expect(getClaimableMembershipPackages).toHaveBeenCalledTimes(2);
    });
    expect(requestSiteLicensePool).not.toHaveBeenCalled();
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
      expect(
        screen.getByText(
          "Review institution terms before claiming this membership.",
        ),
      ).toBeTruthy();
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
