import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { ManagedCpuAdminOverview } from "./managed-cpu-overview";

const getManagedCpuAdminOverview = jest.fn();
const getManagedEgressAdminOverview = jest.fn();
const adminResetMembershipUsageWindows = jest.fn();
const messageSuccess = jest.fn();
const mockRunFreshAuthAction = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});

jest.mock("antd", () => {
  const Div = ({ children, title }: any) => (
    <div>
      {title}
      {children}
    </div>
  );
  const MockInput = ({ value, onChange, placeholder }: any) => (
    <input value={value} onChange={onChange} placeholder={placeholder} />
  );
  MockInput.TextArea = ({ value, onChange, placeholder }: any) => (
    <textarea value={value} onChange={onChange} placeholder={placeholder} />
  );
  return {
    Alert: Div,
    Button: ({ children, onClick, href, disabled }: any) => (
      <button
        type="button"
        onClick={onClick}
        data-href={href}
        disabled={disabled}
      >
        {children}
      </button>
    ),
    Empty: Object.assign(({ description }: any) => <div>{description}</div>, {
      PRESENTED_IMAGE_SIMPLE: "simple",
    }),
    Input: MockInput,
    Segmented: ({ options, onChange, value }: any) => (
      <div>
        {options.map((option: any) => {
          const optionValue = option.value ?? option;
          const optionLabel = option.label ?? optionValue;
          return (
            <button
              key={optionValue}
              aria-pressed={value === optionValue}
              type="button"
              onClick={() => onChange(optionValue)}
            >
              {optionLabel}
            </button>
          );
        })}
      </div>
    ),
    Select: ({ value, onChange, options }: any) => (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
    Space: ({ children }: any) => <div>{children}</div>,
    Spin: () => <div>loading</div>,
    Tag: ({ children }: any) => <div>{children}</div>,
    Typography: {
      Paragraph: ({ children }: any) => <div>{children}</div>,
      Text: ({ children }: any) => <div>{children}</div>,
    },
    message: {
      success: (...args: any[]) => messageSuccess(...args),
    },
  };
});

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => <div data-testid="fresh-auth-modal" />,
  useFreshAuthAction: () => ({
    runFreshAuthAction: mockRunFreshAuthAction,
    freshAuthModalProps: {},
  }),
}));

jest.mock("@cocalc/frontend/components/error", () => ({
  __esModule: true,
  default: ({ error }: any) => <div>{error}</div>,
}));

jest.mock("@cocalc/frontend/components", () => ({
  CopyToClipBoard: ({ value }: any) => <button>{`copy:${value}`}</button>,
}));

jest.mock("@cocalc/frontend/admin/abuse-annotation-controls", () => ({
  AbuseAnnotationControls: ({
    account_id,
    project_id,
    defaultCategory,
  }: any) => (
    <button>{`annotate:${defaultCategory}:${account_id}:${project_id ?? "all"}`}</button>
  ),
  reviewSortRank: () => 2,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    conat_client: {
      hub: {
        purchases: {
          getManagedCpuAdminOverview: (...args: any[]) =>
            getManagedCpuAdminOverview(...args),
          getManagedEgressAdminOverview: (...args: any[]) =>
            getManagedEgressAdminOverview(...args),
          adminResetMembershipUsageWindows: (...args: any[]) =>
            adminResetMembershipUsageWindows(...args),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/purchases/managed-egress-history", () => ({
  ManagedEgressHistoryButton: ({ buttonText, user_account_id }: any) => (
    <button>{`${buttonText}:${user_account_id}`}</button>
  ),
  ManagedEgressRateSummary: () => <div>egress-rate-summary</div>,
}));

jest.mock("@cocalc/frontend/purchases/managed-cpu-history", () => ({
  ManagedCpuHistoryButton: ({
    buttonText,
    user_account_id,
    project_id,
  }: any) => (
    <button>{`${buttonText}:${user_account_id ?? "all"}:${project_id ?? "all"}`}</button>
  ),
}));

jest.mock("@cocalc/frontend/purchases/managed-egress-recent-events", () => ({
  ManagedEgressRecentEventsButton: ({ events }: any) => (
    <div>{`egress-events:${events?.length ?? 0}`}</div>
  ),
}));

describe("ManagedCpuAdminOverview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunFreshAuthAction.mockImplementation(
      async (action: () => Promise<void>) => {
        await action();
        return true;
      },
    );
    adminResetMembershipUsageWindows.mockResolvedValue({
      windows: [
        { scope: "membership", window: "5h", epoch: 2 },
        { scope: "membership", window: "7d", epoch: 2 },
      ],
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    });
    jest.useFakeTimers().setSystemTime(new Date("2026-05-31T12:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function mockOverview() {
    getManagedCpuAdminOverview.mockResolvedValue({
      start: "2026-05-31T07:00:00.000Z",
      end: "2026-05-31T12:00:00.000Z",
      total_cpu_seconds: 7200,
      top_accounts: [
        {
          account_id: "acct-1",
          email_address: "ada@example.com",
          first_name: "Ada",
          last_name: "Lovelace",
          banned: true,
          membership_class: "student-ucla-summer-2026",
          membership_label: "UCLA Student",
          membership_source: "grant",
          cpu_seconds: 7200,
        },
      ],
      top_projects: [
        {
          account_id: "acct-1",
          email_address: "ada@example.com",
          first_name: "Ada",
          last_name: "Lovelace",
          banned: true,
          membership_class: "student-ucla-summer-2026",
          membership_label: "UCLA Student",
          membership_source: "grant",
          project_id: "project-1",
          project_title: "Number theory",
          host_id: "host-1",
          cpu_seconds: 5400,
        },
      ],
      recent_events: [
        {
          account_id: "acct-1",
          project_id: "project-1",
          project_title: "Number theory",
          host_id: "host-1",
          cpu_seconds: 60,
          sample_started_at: "2026-05-31T11:59:00.000Z",
          sample_ended_at: "2026-05-31T12:00:00.000Z",
          source: "project-host-cgroup",
          metadata: null,
        },
      ],
    });
    getManagedEgressAdminOverview.mockResolvedValue({
      start: "2026-05-31T07:00:00.000Z",
      end: "2026-05-31T12:00:00.000Z",
      total_bytes: 4096,
      categories_bytes: {},
      top_accounts: [
        {
          account_id: "acct-2",
          email_address: "grace@example.com",
          first_name: "Grace",
          last_name: "Hopper",
          banned: false,
          membership_class: "free",
          membership_label: "Free",
          membership_source: "free",
          bytes: 4096,
        },
      ],
      top_projects: [
        {
          account_id: "acct-2",
          email_address: "grace@example.com",
          first_name: "Grace",
          last_name: "Hopper",
          banned: false,
          membership_class: "free",
          membership_label: "Free",
          membership_source: "free",
          project_id: "project-2",
          project_title: "Downloader",
          bytes: 2048,
        },
      ],
      recent_events: [
        {
          account_id: "acct-2",
          project_id: "project-2",
          project_title: "Downloader",
          category: "raw-network",
          bytes: 2048,
          occurred_at: "2026-05-31T11:59:00.000Z",
          metadata: null,
        },
      ],
    });
  }

  it("shows CPU and egress abuse signals for the selected window", async () => {
    mockOverview();

    render(<ManagedCpuAdminOverview />);

    await waitFor(() => {
      expect(screen.getByText("Top CPU accounts (5h)")).toBeTruthy();
      expect(screen.getByText("Top CPU projects (5h)")).toBeTruthy();
      expect(screen.getByText("Top egress accounts (5h)")).toBeTruthy();
      expect(screen.getByText("Top egress projects (5h)")).toBeTruthy();
      expect(
        screen.getAllByText("Ada Lovelace (ada@example.com)").length,
      ).toBeGreaterThan(0);
      expect(screen.getAllByText("Banned").length).toBeGreaterThan(0);
      expect(screen.getAllByText("UCLA Student").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Free").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Number theory").length).toBeGreaterThan(0);
      expect(screen.getByText("Downloader")).toBeTruthy();
      expect(screen.getAllByText(/2.00 CPU-hours/).length).toBeGreaterThan(0);
      expect(screen.getByText("Global CPU history:all:all")).toBeTruthy();
      expect(screen.getByText("CPU history:acct-1:all")).toBeTruthy();
      expect(screen.getByText("CPU history:acct-1:project-1")).toBeTruthy();
      expect(screen.getByText("annotate:cpu:acct-1:all")).toBeTruthy();
      expect(screen.getByText("annotate:cpu:acct-1:project-1")).toBeTruthy();
      expect(screen.getByText("annotate:egress:acct-2:all")).toBeTruthy();
      expect(screen.getByText("egress-events:1")).toBeTruthy();
      expect(screen.getByText("egress-rate-summary")).toBeTruthy();
    });

    const cpuCall = getManagedCpuAdminOverview.mock.calls[0][0];
    const egressCall = getManagedEgressAdminOverview.mock.calls[0][0];
    expect(cpuCall.start.toISOString()).toBe("2026-05-31T07:00:00.000Z");
    expect(cpuCall.end.toISOString()).toBe("2026-05-31T12:00:00.000Z");
    expect(egressCall.start.toISOString()).toBe("2026-05-31T07:00:00.000Z");
    expect(egressCall.end.toISOString()).toBe("2026-05-31T12:00:00.000Z");
  });

  it("copies a markdown summary of the current review window", async () => {
    mockOverview();
    render(<ManagedCpuAdminOverview />);

    await waitFor(() => {
      expect(screen.getByText("Top CPU accounts (5h)")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Copy summary"));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
      expect(messageSuccess).toHaveBeenCalledWith(
        "CPU and abuse summary copied.",
      );
    });
    const summary = (navigator.clipboard.writeText as jest.Mock).mock
      .calls[0][0];
    expect(summary).toContain("# CPU & Abuse Signals, 5h window");
    expect(summary).toContain(
      "Ada Lovelace (ada@example.com) (acct-1) - 2.00 CPU-hours",
    );
    expect(summary).toContain(
      "Number theory (project-1), host host-1, Ada Lovelace (ada@example.com) (acct-1) - 1.50 CPU-hours",
    );
    expect(summary).toContain(
      "Grace Hopper (grace@example.com) (acct-2) - 4.1 KB",
    );
  });

  it("reloads CPU and egress overview for the selected range", async () => {
    mockOverview();
    render(<ManagedCpuAdminOverview />);

    await waitFor(() => {
      expect(getManagedCpuAdminOverview).toHaveBeenCalledTimes(1);
      expect(getManagedEgressAdminOverview).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "7d" }));

    await waitFor(() => {
      expect(getManagedCpuAdminOverview).toHaveBeenCalledTimes(2);
      expect(getManagedEgressAdminOverview).toHaveBeenCalledTimes(2);
    });
    const cpuCall = getManagedCpuAdminOverview.mock.calls[1][0];
    expect(cpuCall.start.toISOString()).toBe("2026-05-24T12:00:00.000Z");
    expect(cpuCall.end.toISOString()).toBe("2026-05-31T12:00:00.000Z");
  });

  it("does not auto-refresh CPU and egress overviews", async () => {
    mockOverview();
    render(<ManagedCpuAdminOverview />);

    await waitFor(() => {
      expect(getManagedCpuAdminOverview).toHaveBeenCalledTimes(1);
      expect(getManagedEgressAdminOverview).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      jest.advanceTimersByTime(5 * 60 * 1000);
    });

    expect(getManagedCpuAdminOverview).toHaveBeenCalledTimes(1);
    expect(getManagedEgressAdminOverview).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(getManagedCpuAdminOverview).toHaveBeenCalledTimes(2);
      expect(getManagedEgressAdminOverview).toHaveBeenCalledTimes(2);
    });
  });

  it("resets shared membership usage windows through fresh auth", async () => {
    mockOverview();
    render(<ManagedCpuAdminOverview />);

    await waitFor(() => {
      expect(screen.getByText("Top CPU accounts (5h)")).toBeTruthy();
    });

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "5h" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        "Explain why this global usage-window reset is needed.",
      ),
      { target: { value: "Bad tier configuration fixed." } },
    );
    fireEvent.click(screen.getByText("Reset windows"));

    await waitFor(() => {
      expect(mockRunFreshAuthAction).toHaveBeenCalledTimes(1);
      expect(adminResetMembershipUsageWindows).toHaveBeenCalledWith({
        window: "5h",
        reason: "Bad tier configuration fixed.",
        browser_id: "browser-1",
      });
      expect(messageSuccess).toHaveBeenCalledWith(
        "Membership usage windows reset.",
      );
    });
    expect(getManagedCpuAdminOverview).toHaveBeenCalledTimes(2);
    expect(getManagedEgressAdminOverview).toHaveBeenCalledTimes(2);
  });
});
