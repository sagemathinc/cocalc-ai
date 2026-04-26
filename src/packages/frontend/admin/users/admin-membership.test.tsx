import { render, screen, waitFor } from "@testing-library/react";
import { AdminMembership } from "./admin-membership";

const api = jest.fn();
const getMembershipDetails = jest.fn();
const getAdminMembership = jest.fn();

jest.mock("antd", () => {
  const Button = ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  );
  const Div = ({ children, title }: any) => (
    <div>
      {title}
      {children}
    </div>
  );
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
    DatePicker,
    Descriptions: Object.assign(Div, { Item: Div }),
    Divider: Div,
    Input,
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

jest.mock("./actions", () => ({
  actions: {
    get_admin_membership: (...args: any[]) => getAdminMembership(...args),
    set_admin_membership: jest.fn(),
    clear_admin_membership: jest.fn(),
  },
}));

describe("AdminMembership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      },
    });

    render(<AdminMembership account_id="acct-1" />);

    await waitFor(() => {
      expect(screen.getByText(/usage summary/i)).toBeTruthy();
      expect(screen.getByText(/over the hard total storage cap/i)).toBeTruthy();
      expect(screen.getByText(/over the owned project limit/i)).toBeTruthy();
      expect(
        screen.getByText(/only partially sampled from owned projects/i),
      ).toBeTruthy();
    });
  });
});
