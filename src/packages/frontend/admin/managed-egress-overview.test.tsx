import { render, screen, waitFor } from "@testing-library/react";

import { ManagedEgressAdminOverview } from "./managed-egress-overview";

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
    Button: ({ children, onClick }: any) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    Empty: Object.assign(({ description }: any) => <div>{description}</div>, {
      PRESENTED_IMAGE_SIMPLE: "simple",
    }),
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

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        purchases: {
          getManagedEgressAdminOverview: (...args: any[]) =>
            getManagedEgressAdminOverview(...args),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/purchases/managed-egress-history", () => ({
  ManagedEgressHistoryButton: ({
    buttonText,
    user_account_id,
    project_id,
  }: any) => (
    <button>{`${buttonText}:${user_account_id}:${project_id ?? "none"}`}</button>
  ),
}));

jest.mock("@cocalc/frontend/purchases/managed-egress-recent-events", () => ({
  ManagedEgressRecentEventsButton: ({ events }: any) => (
    <div>{`recent-events:${events?.length ?? 0}`}</div>
  ),
  formatManagedEgressCategory: (value: string) => value,
}));

describe("ManagedEgressAdminOverview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows top accounts and top projects from the admin overview", async () => {
    getManagedEgressAdminOverview.mockResolvedValue({
      start: "2026-04-28T00:00:00.000Z",
      end: "2026-04-29T00:00:00.000Z",
      total_bytes: 10240,
      categories_bytes: {
        "raw-network": 8192,
        "file-download": 2048,
      },
      top_accounts: [
        {
          account_id: "acct-1",
          email_address: "ada@example.com",
          first_name: "Ada",
          last_name: "Lovelace",
          bytes: 8192,
        },
      ],
      top_projects: [
        {
          account_id: "acct-1",
          email_address: "ada@example.com",
          first_name: "Ada",
          last_name: "Lovelace",
          project_id: "project-1",
          project_title: "Lite One",
          bytes: 4096,
        },
      ],
      recent_events: [
        {
          account_id: "acct-1",
          project_id: "project-1",
          project_title: "Lite One",
          category: "raw-network",
          bytes: 4096,
          occurred_at: "2026-04-28T10:00:00.000Z",
          metadata: null,
        },
      ],
    });

    render(<ManagedEgressAdminOverview />);

    await waitFor(() => {
      expect(screen.getByText("Top recent egress accounts (24h)")).toBeTruthy();
      expect(
        screen.getAllByText("Ada Lovelace (ada@example.com)").length,
      ).toBeGreaterThan(0);
      expect(screen.getByText("Account history:acct-1:none")).toBeTruthy();
      expect(screen.getByText("Top recent egress projects (24h)")).toBeTruthy();
      expect(screen.getByText("Lite One")).toBeTruthy();
      expect(screen.getByText("Project history:acct-1:project-1")).toBeTruthy();
      expect(screen.getByText("recent-events:1")).toBeTruthy();
    });
  });
});
