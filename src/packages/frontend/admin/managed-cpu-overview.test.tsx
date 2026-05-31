import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ManagedCpuAdminOverview } from "./managed-cpu-overview";

const getManagedCpuAdminOverview = jest.fn();
const getManagedEgressAdminOverview = jest.fn();

jest.mock("antd", () => {
  const Div = ({ children, title }: any) => (
    <div>
      {title}
      {children}
    </div>
  );
  return {
    Alert: Div,
    Button: ({ children, onClick, href }: any) => (
      <button type="button" onClick={onClick} data-href={href}>
        {children}
      </button>
    ),
    Empty: Object.assign(({ description }: any) => <div>{description}</div>, {
      PRESENTED_IMAGE_SIMPLE: "simple",
    }),
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
    Space: ({ children }: any) => <div>{children}</div>,
    Spin: () => <div>loading</div>,
    Tag: ({ children }: any) => <div>{children}</div>,
    Typography: {
      Paragraph: ({ children }: any) => <div>{children}</div>,
      Text: ({ children }: any) => <div>{children}</div>,
    },
  };
});

jest.mock("@cocalc/frontend/components/error", () => ({
  __esModule: true,
  default: ({ error }: any) => <div>{error}</div>,
}));

jest.mock("@cocalc/frontend/components", () => ({
  CopyToClipBoard: ({ value }: any) => <button>{`copy:${value}`}</button>,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        purchases: {
          getManagedCpuAdminOverview: (...args: any[]) =>
            getManagedCpuAdminOverview(...args),
          getManagedEgressAdminOverview: (...args: any[]) =>
            getManagedEgressAdminOverview(...args),
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

jest.mock("@cocalc/frontend/purchases/managed-egress-recent-events", () => ({
  ManagedEgressRecentEventsButton: ({ events }: any) => (
    <div>{`egress-events:${events?.length ?? 0}`}</div>
  ),
}));

describe("ManagedCpuAdminOverview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
          cpu_seconds: 7200,
        },
      ],
      top_projects: [
        {
          account_id: "acct-1",
          email_address: "ada@example.com",
          first_name: "Ada",
          last_name: "Lovelace",
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
          bytes: 4096,
        },
      ],
      top_projects: [
        {
          account_id: "acct-2",
          email_address: "grace@example.com",
          first_name: "Grace",
          last_name: "Hopper",
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
      expect(screen.getAllByText("Number theory").length).toBeGreaterThan(0);
      expect(screen.getByText("Downloader")).toBeTruthy();
      expect(screen.getAllByText(/2.00 CPU-hours/).length).toBeGreaterThan(0);
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
});
