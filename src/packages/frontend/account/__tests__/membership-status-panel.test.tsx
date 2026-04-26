import { act, render, screen, waitFor } from "@testing-library/react";
import { MembershipStatusPanel } from "../membership-status";

const api = jest.fn();
const getMembershipDetails = jest.fn();

let accountId = "account-1";

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
  return {
    Alert: Div,
    Button,
    Collapse: Div,
    Descriptions: Object.assign(Div, { Item: Div }),
    Divider: Div,
    Space: Div,
    Tag: Div,
    Table: Div,
    Typography: {
      Text: Div,
    },
  };
});

jest.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: any) => defaultMessage ?? "",
  }),
}));

jest.mock("@cocalc/frontend/client/api", () => ({
  __esModule: true,
  default: (...args: any[]) => api(...args),
}));

jest.mock("@cocalc/frontend/antd-bootstrap", () => ({
  Panel: ({ children, header }: any) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Loading: () => <div>loading</div>,
}));

jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: () => null,
}));

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    useAsyncEffect: (fn: any, deps: any[]) => {
      React.useEffect(() => {
        let mounted = true;
        void fn(() => mounted);
        return () => {
          mounted = false;
        };
      }, deps);
    },
    useTypedRedux: () => accountId,
  };
});

jest.mock("@cocalc/frontend/misc/llm-cost-estimation", () => ({
  LLMUsageStatus: () => null,
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    project: {
      defaultMessage: "Project",
    },
  },
}));

jest.mock("./../membership-purchase-modal", () => () => null);

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("MembershipStatusPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    accountId = "account-1";
  });

  it("clears the previous tier immediately when the account changes", async () => {
    const firstMembership = deferred<any>();
    const firstTiers = deferred<any>();
    const firstDetails = deferred<any>();
    const secondMembership = deferred<any>();
    const secondTiers = deferred<any>();
    const secondDetails = deferred<any>();
    api
      .mockReturnValueOnce(firstMembership.promise)
      .mockReturnValueOnce(firstTiers.promise)
      .mockReturnValueOnce(secondMembership.promise)
      .mockReturnValueOnce(secondTiers.promise);
    getMembershipDetails
      .mockReturnValueOnce(firstDetails.promise)
      .mockReturnValueOnce(secondDetails.promise);

    const { rerender } = render(<MembershipStatusPanel showHeader={false} />);

    await act(async () => {
      firstMembership.resolve({ class: "pro", source: "subscription" });
      firstTiers.resolve([{ id: "pro", label: "Pro" }]);
      firstDetails.resolve({
        candidates: [],
        selected: { class: "pro", source: "subscription" },
        usage_status: {
          collected_at: new Date().toISOString(),
          owned_project_count: 1,
          sampled_project_count: 1,
          unsampled_project_count: 0,
          total_storage_bytes: 100,
        },
      });
      await Promise.all([
        firstMembership.promise,
        firstTiers.promise,
        firstDetails.promise,
      ]);
    });

    await waitFor(() => {
      expect(screen.getByText("Pro")).toBeTruthy();
    });

    accountId = "account-2";
    rerender(<MembershipStatusPanel showHeader={false} />);

    await waitFor(() => {
      expect(screen.queryByText("Pro")).toBeNull();
      expect(screen.getByText("loading")).toBeTruthy();
    });

    await act(async () => {
      secondMembership.resolve({ class: "free", source: "free" });
      secondTiers.resolve([{ id: "free", label: "Free" }]);
      secondDetails.resolve({
        candidates: [],
        selected: { class: "free", source: "free" },
        usage_status: {
          collected_at: new Date().toISOString(),
          owned_project_count: 0,
          sampled_project_count: 0,
          unsampled_project_count: 0,
          total_storage_bytes: 0,
        },
      });
      await Promise.all([
        secondMembership.promise,
        secondTiers.promise,
        secondDetails.promise,
      ]);
    });

    await waitFor(() => {
      expect(screen.queryByText("Pro")).toBeNull();
      expect(screen.getAllByText("Free").length).toBeGreaterThan(0);
    });
  });

  it("shows explicit warnings when usage is over configured limits", async () => {
    api
      .mockResolvedValueOnce({ class: "pro", source: "subscription" })
      .mockResolvedValueOnce([{ id: "pro", label: "Pro" }]);
    getMembershipDetails.mockResolvedValueOnce({
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
        total_storage_hard_bytes: 150,
        over_total_storage_soft: true,
        over_total_storage_hard: true,
        max_projects: 4,
        over_max_projects: true,
      },
    });

    render(<MembershipStatusPanel showHeader={false} />);

    await waitFor(() => {
      expect(screen.getByText(/over the hard total storage cap/i)).toBeTruthy();
      expect(screen.getByText(/over the owned project limit/i)).toBeTruthy();
      expect(
        screen.getByText(/only partially sampled from your projects/i),
      ).toBeTruthy();
    });
  });

  it("shows recent managed egress event details", async () => {
    api
      .mockResolvedValueOnce({ class: "pro", source: "subscription" })
      .mockResolvedValueOnce([{ id: "pro", label: "Pro" }]);
    getMembershipDetails.mockResolvedValueOnce({
      candidates: [],
      selected: { class: "pro", source: "subscription" },
      usage_status: {
        collected_at: new Date().toISOString(),
        owned_project_count: 1,
        sampled_project_count: 1,
        unsampled_project_count: 0,
        total_storage_bytes: 10,
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

    render(<MembershipStatusPanel showHeader={false} />);

    await waitFor(() => {
      expect(screen.getByText("File downloads")).toBeTruthy();
      expect(screen.getByText("Data Lab")).toBeTruthy();
      expect(screen.getByText("/files/export.csv?download")).toBeTruthy();
    });
  });
});
