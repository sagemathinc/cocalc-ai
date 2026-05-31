import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminMembership } from "./admin-membership";

const api = jest.fn();
const getMembershipDetails = jest.fn();
const getAdminMembership = jest.fn();
const setAdminMembership = jest.fn();
const clearAdminMembership = jest.fn();
const runFreshAuthAction = jest.fn(async (action: () => Promise<void>) => {
  await action();
});

jest.mock("antd", () => {
  const Button = ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  );
  const Div = ({ children, title, label }: any) => (
    <div>
      {title}
      {label}
      {children}
    </div>
  );
  const Collapse = Object.assign(({ children }: any) => <div>{children}</div>, {
    Panel: ({ children, header }: any) => (
      <div>
        {header}
        {children}
      </div>
    ),
  });
  const Select = ({ value, onChange }: any) => (
    <select
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value || undefined)}
    />
  );
  const Input = ({ value, onChange }: any) => (
    <input value={value ?? ""} onChange={onChange} />
  );
  Input.TextArea = ({ value, onChange }: any) => (
    <textarea value={value ?? ""} onChange={onChange} />
  );
  const DatePicker = () => null;
  const Table = ({ dataSource }: any) => (
    <div>{JSON.stringify(dataSource ?? [])}</div>
  );
  return {
    Alert: Div,
    Button,
    Collapse,
    DatePicker,
    Descriptions: Object.assign(Div, { Item: Div }),
    Divider: Div,
    Input,
    Modal: ({ open, title, children }: any) =>
      open ? (
        <div>
          {title}
          {children}
        </div>
      ) : null,
    Popover: Div,
    Select,
    Space: Div,
    Spin: () => <div>loading</div>,
    Table,
    Tag: Div,
    Typography: {
      Text: Div,
    },
    message: {
      success: jest.fn(),
    },
  };
});

jest.mock("@cocalc/frontend/client/api", () => ({
  __esModule: true,
  default: (...args: any[]) => api(...args),
}));

jest.mock("@cocalc/frontend/components", () => ({
  ErrorDisplay: ({ error }: any) => <div>{error}</div>,
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: (...args: any[]) => runFreshAuthAction(...args),
    freshAuthModalProps: {},
  }),
}));

jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: () => null,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        purchases: {
          getMembershipDetails: (...args: any[]) =>
            getMembershipDetails(...args),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/purchases/managed-egress-history", () => ({
  ManagedEgressHistoryButton: ({ buttonText }: any) => (
    <button>{buttonText}</button>
  ),
  ManagedEgressRateSummary: () => <div>recent-egress-summary</div>,
  ManagedEgressTopProjectsSummary: () => <div>top-projects-summary</div>,
}));

jest.mock("./actions", () => ({
  actions: {
    get_admin_membership: (...args: any[]) => getAdminMembership(...args),
    set_admin_membership: (...args: any[]) => setAdminMembership(...args),
    clear_admin_membership: (...args: any[]) => clearAdminMembership(...args),
  },
}));

jest.mock("./account-entitlement-override", () => ({
  AccountEntitlementOverridePanel: () => null,
}));

describe("AdminMembership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runFreshAuthAction.mockImplementation(
      async (action: () => Promise<void>) => {
        await action();
      },
    );
  });

  function mockLoadedMembership() {
    getAdminMembership.mockResolvedValue({
      account_id: "acct-1",
      membership_class: "pro",
      assigned_by: "admin-1",
      assigned_at: new Date().toISOString(),
      expires_at: null,
      notes: null,
    });
    api.mockResolvedValue({ tiers: [{ id: "pro", label: "Pro" }] });
    getMembershipDetails.mockResolvedValue({
      candidates: [],
      selected: { class: "pro", source: "admin" },
    });
  }

  it("requires fresh auth before changing an admin-assigned membership", async () => {
    mockLoadedMembership();
    setAdminMembership.mockResolvedValue(undefined);

    render(<AdminMembership account_id="acct-1" />);

    await waitFor(() => expect(screen.getByText("Update")).toBeTruthy());

    fireEvent.click(screen.getByText("Update"));

    await waitFor(() => {
      expect(runFreshAuthAction).toHaveBeenCalledTimes(1);
      expect(setAdminMembership).toHaveBeenCalledWith({
        account_id: "acct-1",
        membership_class: "pro",
        expires_at: null,
        notes: null,
      });
    });
  });

  it("requires fresh auth before clearing an admin-assigned membership", async () => {
    mockLoadedMembership();
    clearAdminMembership.mockResolvedValue(undefined);

    render(<AdminMembership account_id="acct-1" />);

    await waitFor(() => expect(screen.getByText("Clear")).toBeTruthy());

    fireEvent.click(screen.getByText("Clear"));

    await waitFor(() => {
      expect(runFreshAuthAction).toHaveBeenCalledTimes(1);
      expect(clearAdminMembership).toHaveBeenCalledWith("acct-1");
    });
  });

  it("shows an explicit usage summary for the searched user", async () => {
    getAdminMembership.mockResolvedValue(null);
    api.mockResolvedValue({ tiers: [{ id: "pro", label: "Pro" }] });
    getMembershipDetails.mockResolvedValue({
      candidates: [],
      selected: { class: "pro", source: "subscription" },
      usage_status: {
        collected_at: new Date().toISOString(),
        owned_project_count: 5,
        sampled_project_count: 4,
        unsampled_project_count: 1,
        measurement_error_count: 1,
        total_storage_bytes: 200,
        total_storage_soft_bytes: 100,
        total_storage_soft_remaining_bytes: -100,
        total_storage_hard_bytes: 150,
        total_storage_hard_remaining_bytes: -50,
        over_total_storage_soft: true,
        over_total_storage_hard: true,
        max_projects: 4,
        remaining_project_slots: -1,
        over_max_projects: true,
        managed_cpu_5h_seconds: 7200,
        managed_cpu_5h_remaining_seconds: -1800,
        managed_cpu_7d_seconds: 18000,
        managed_cpu_7d_remaining_seconds: 10800,
        over_managed_cpu_5h: true,
        managed_egress_recent_events: [
          {
            project_id: "project-1",
            project_title: "Data Lab",
            category: "file-download",
            bytes: 4096,
            occurred_at: "2026-04-25T12:00:00.000Z",
            metadata: { request_path: "/files/export.csv?download" },
          },
        ],
      },
    });

    render(<AdminMembership account_id="acct-1" />);

    await waitFor(() => {
      expect(screen.getByText(/usage summary/i)).toBeTruthy();
      expect(screen.getByText(/over the hard total storage cap/i)).toBeTruthy();
      expect(screen.getByText(/over the project limit/i)).toBeTruthy();
      expect(
        screen.getByText(
          /only partially sampled from this user's attributed projects/i,
        ),
      ).toBeTruthy();
      expect(screen.getByText(/managed-CPU 5-hour window/i)).toBeTruthy();
      expect(screen.getByText(/Managed CPU used in 5 hours/)).toBeTruthy();
      expect(screen.getByText(/Managed CPU remaining in 5 hours/)).toBeTruthy();
      expect(screen.getByText(/Over by 0.500 CPU-hours/)).toBeTruthy();
      expect(screen.getByText(/5.00 CPU-hours/)).toBeTruthy();
      expect(screen.getByText("Recent managed egress")).toBeTruthy();
      expect(screen.getByText("Top recent egress projects (24h)")).toBeTruthy();
      expect(screen.getByText("Historical managed egress")).toBeTruthy();
      expect(screen.getByText("View recent events (1)")).toBeTruthy();
      expect(screen.getByText("View egress history")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("View recent events (1)"));

    expect(
      screen.getAllByText("Recent managed egress events").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Data Lab")).toBeTruthy();
    expect(screen.getByText("/files/export.csv?download")).toBeTruthy();
  });
});
