import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CodexCredentialsPanel } from "./codex-credentials-panel";

const getCodexPaymentSource = jest.fn();
const getCodexUsageStatus = jest.fn();
const codexDeviceAuthStart = jest.fn();
const codexDeviceAuthStatus = jest.fn();
const mockClipboardWriteText = jest.fn();

jest.mock("antd", () => {
  const Button = ({ children, disabled, href, loading, onClick }: any) =>
    href ? (
      <a href={href}>{children}</a>
    ) : (
      <button type="button" disabled={disabled || loading} onClick={onClick}>
        {children}
      </button>
    );
  const Div = ({ children, message, title, description }: any) => (
    <div>
      {title}
      {message}
      {description}
      {children}
    </div>
  );
  const Collapse = ({
    activeKey,
    children,
    defaultActiveKey,
    items,
    onChange,
  }: any) => {
    const keyValue = activeKey ?? defaultActiveKey ?? [];
    const activeKeys = Array.isArray(keyValue) ? keyValue : [keyValue];
    return (
      <div>
        {items?.map((item: any) => {
          const active = activeKeys.includes(item.key);
          return (
            <div key={item.key}>
              <button
                type="button"
                aria-expanded={active}
                onClick={() => {
                  const nextKeys = active
                    ? activeKeys.filter((key: string) => key !== item.key)
                    : [...activeKeys, item.key];
                  onChange?.(nextKeys);
                }}
              >
                {item.label}
              </button>
              {active ? item.children : null}
            </div>
          );
        })}
        {children}
      </div>
    );
  };
  const TextArea = ({ value }: any) => <div>{value}</div>;
  const Progress = ({ percent }: any) => (
    <div role="progressbar" aria-valuenow={percent} />
  );
  return {
    Alert: Div,
    Button,
    Collapse,
    Input: { TextArea },
    Popconfirm: Div,
    Progress,
    Space: Div,
    Table: Div,
    Tag: Div,
    Typography: { Text: Div },
    message: { error: jest.fn(), success: jest.fn() },
  };
});

jest.mock("@cocalc/frontend/antd-bootstrap", () => ({
  Panel: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useAsyncEffect: (fn: any, deps: any[]) => {
    const React = require("react");
    React.useEffect(() => {
      let mounted = true;
      void fn(() => mounted);
      return () => {
        mounted = false;
      };
    }, deps);
  },
  useTypedRedux: () => undefined,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Loading: () => <div>loading</div>,
}));

jest.mock("@cocalc/frontend/components/password", () => () => null);
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => <div data-testid="fresh-auth-modal" />,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: async (action: () => Promise<void>) => {
      await action();
      return true;
    },
  }),
}));
jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: ({ date }: any) => (
    <span>{date instanceof Date ? "time-ago-date" : "time-ago"}</span>
  ),
}));
jest.mock("@cocalc/frontend/lite", () => ({
  lite: true,
}));
jest.mock("@cocalc/frontend/projects/select-project", () => ({
  SelectProject: () => null,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          codexDeviceAuthStart: (...args: any[]) =>
            codexDeviceAuthStart(...args),
          codexDeviceAuthStatus: (...args: any[]) =>
            codexDeviceAuthStatus(...args),
        },
        system: {
          getCodexPaymentSource: (...args: any[]) =>
            getCodexPaymentSource(...args),
          getCodexUsageStatus: (...args: any[]) => getCodexUsageStatus(...args),
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

describe("CodexCredentialsPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mockClipboardWriteText },
    });
  });

  it("clears the previous payment source label immediately when the project changes", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    getCodexPaymentSource
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    getCodexUsageStatus.mockResolvedValue({
      available: true,
      checkedAt: "2026-06-10T00:00:00.000Z",
      paymentSource: { source: "subscription" },
      account: {
        account: {
          type: "chatgpt",
          email: "user@example.com",
          planType: "pro",
        },
      },
      rateLimits: {
        rateLimits: {
          primary: { usedPercent: 42, windowDurationMins: 300 },
          secondary: {
            usedPercent: 7,
            windowDurationMins: 10_080,
            resetsAt: 1_800_000_000,
          },
        },
      },
    });

    const { rerender } = render(
      <CodexCredentialsPanel embedded defaultProjectId="project-1" />,
    );

    await act(async () => {
      first.resolve({ source: "subscription" });
      await first.promise;
    });

    await waitFor(() => {
      expect(screen.getAllByText("ChatGPT Plan").length).toBeGreaterThan(0);
      expect(screen.getByText("Current Codex payment source:")).toBeTruthy();
      expect(
        screen.getAllByText("Open ChatGPT Codex Usage").length,
      ).toBeGreaterThan(0);
      expect(screen.getByText("user@example.com")).toBeTruthy();
      expect(screen.getByText("5-hour limit")).toBeTruthy();
      expect(screen.getByText("58%")).toBeTruthy();
      expect(screen.getAllByText("Remaining").length).toBeGreaterThan(0);
      expect(screen.getByText("7-day limit")).toBeTruthy();
      expect(screen.getByText("93%")).toBeTruthy();
      expect(screen.getByText("time-ago-date")).toBeTruthy();
    });

    rerender(<CodexCredentialsPanel embedded defaultProjectId="project-2" />);

    await waitFor(() => {
      expect(screen.queryByText("Current Codex payment source:")).toBeNull();
      expect(screen.getByText("loading")).toBeTruthy();
    });

    await act(async () => {
      second.resolve({ source: "none" });
      await second.promise;
    });

    await waitFor(() => {
      expect(screen.getByText("Codex is not connected yet.")).toBeTruthy();
    });
  });

  it("shows a visible reauth CTA for stale ChatGPT subscriptions", async () => {
    getCodexPaymentSource.mockResolvedValue({ source: "subscription" });
    getCodexUsageStatus.mockResolvedValue({
      available: false,
      checkedAt: "2026-06-10T00:00:00.000Z",
      paymentSource: { source: "subscription" },
      reason:
        "account/rateLimits/read: codex account authentication required to read rate limits",
    });
    codexDeviceAuthStart.mockResolvedValue({
      id: "auth-1",
      projectId: "project-1",
      accountId: "account-1",
      codexHome: "/tmp/.codex",
      state: "pending",
      verificationUrl: "https://chatgpt.com/device",
      userCode: "ABCD-EFGH",
      output: "",
      startedAt: 1,
      updatedAt: 1,
    });

    render(<CodexCredentialsPanel embedded defaultProjectId="project-1" />);

    await waitFor(() => {
      expect(screen.getByText("Refresh your ChatGPT sign-in")).toBeTruthy();
      expect(screen.getByText("Sign-in needs refresh")).toBeTruthy();
      expect(screen.queryByText("Connect Codex with ChatGPT")).toBeNull();
      expect(screen.getByText("Sign in again with ChatGPT")).toBeTruthy();
      expect(
        screen.getByText((text) =>
          text.includes("live rate-limit details are not available"),
        ),
      ).toBeTruthy();
      expect(
        screen.queryByText((text) => text.includes("account/rateLimits/read")),
      ).toBeNull();
    });

    await act(async () => {
      screen.getByText("Sign in again with ChatGPT").click();
    });

    expect(codexDeviceAuthStart).toHaveBeenCalledWith({
      project_id: "project-1",
    });
    await waitFor(() => {
      expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    });
  });

  it("refreshes Codex usage without reloading the whole payment panel", async () => {
    const refreshedUsage = deferred<any>();
    getCodexPaymentSource.mockResolvedValue({ source: "subscription" });
    getCodexUsageStatus
      .mockResolvedValueOnce({
        available: true,
        checkedAt: "2026-06-10T00:00:00.000Z",
        paymentSource: { source: "subscription" },
        account: {
          account: {
            type: "chatgpt",
            email: "user@example.com",
            planType: "pro",
          },
        },
        rateLimits: {
          rateLimits: {
            primary: { usedPercent: 42, windowDurationMins: 300 },
            secondary: { usedPercent: 7, windowDurationMins: 10_080 },
          },
        },
      })
      .mockReturnValueOnce(refreshedUsage.promise);

    render(<CodexCredentialsPanel embedded defaultProjectId="project-1" />);

    await waitFor(() => {
      expect(screen.getByText("5-hour limit")).toBeTruthy();
      expect(screen.getByText("58%")).toBeTruthy();
      expect(screen.getByText("7-day limit")).toBeTruthy();
      expect(screen.getByText("93%")).toBeTruthy();
    });
    expect(getCodexPaymentSource).toHaveBeenCalledTimes(1);

    await act(async () => {
      screen.getByText("Refresh usage").click();
      await Promise.resolve();
    });

    expect(getCodexPaymentSource).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("loading")).toBeNull();
    expect(screen.getByText("58%")).toBeTruthy();

    await act(async () => {
      refreshedUsage.resolve({
        available: true,
        checkedAt: "2026-06-10T00:00:01.000Z",
        paymentSource: { source: "subscription" },
        account: {
          account: {
            type: "chatgpt",
            email: "user@example.com",
            planType: "pro",
          },
        },
        rateLimits: {
          rateLimits: {
            primary: { usedPercent: 43, windowDurationMins: 300 },
            secondary: { usedPercent: 8, windowDurationMins: 10_080 },
          },
        },
      });
      await refreshedUsage.promise;
    });

    await waitFor(() => {
      expect(screen.getByText("57%")).toBeTruthy();
      expect(screen.getByText("92%")).toBeTruthy();
    });
  });

  it("clears stale device auth state when the project changes", async () => {
    getCodexPaymentSource.mockResolvedValue({ source: "none" });
    codexDeviceAuthStart.mockResolvedValue({
      id: "auth-1",
      projectId: "project-1",
      accountId: "account-1",
      codexHome: "/tmp/.codex",
      state: "pending",
      output: "",
      startedAt: 1,
      updatedAt: 1,
    });

    const { rerender } = render(
      <CodexCredentialsPanel embedded defaultProjectId="project-1" />,
    );

    await waitFor(() => {
      expect(screen.getByText("Codex is not connected yet.")).toBeTruthy();
    });

    await act(async () => {
      screen.getByText("Sign in with ChatGPT").click();
    });

    await waitFor(() => {
      expect(
        screen.getByText((text) =>
          text.includes("Finish signing in with ChatGPT"),
        ),
      ).toBeTruthy();
    });

    rerender(<CodexCredentialsPanel embedded defaultProjectId="project-2" />);

    await waitFor(() => {
      expect(
        screen.queryByText((text) =>
          text.includes("Finish signing in with ChatGPT"),
        ),
      ).toBeNull();
      expect(screen.getByText("loading")).toBeTruthy();
    });
  });

  it("notifies parent state when device auth completes", async () => {
    jest.useFakeTimers();
    getCodexPaymentSource.mockResolvedValue({ source: "none" });
    codexDeviceAuthStart.mockResolvedValue({
      id: "auth-1",
      projectId: "project-1",
      accountId: "account-1",
      codexHome: "/tmp/.codex",
      state: "pending",
      output: "",
      startedAt: 1,
      updatedAt: 1,
    });
    codexDeviceAuthStatus.mockResolvedValue({
      id: "auth-1",
      projectId: "project-1",
      accountId: "account-1",
      codexHome: "/tmp/.codex",
      state: "completed",
      output: "",
      startedAt: 1,
      updatedAt: 2,
    });
    const onPaymentSourceChanged = jest.fn();

    render(
      <CodexCredentialsPanel
        embedded
        defaultProjectId="project-1"
        onPaymentSourceChanged={onPaymentSourceChanged}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Codex is not connected yet.")).toBeTruthy();
    });

    await act(async () => {
      screen.getByText("Sign in with ChatGPT").click();
    });

    await waitFor(() => {
      expect(
        screen.getByText((text) =>
          text.includes("Finish signing in with ChatGPT"),
        ),
      ).toBeTruthy();
    });

    await act(async () => {
      jest.advanceTimersByTime(1500);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onPaymentSourceChanged).toHaveBeenCalled();
    });
  });

  it("keeps advanced sign-in options closed when embedded sign-in starts", async () => {
    getCodexPaymentSource.mockResolvedValue({ source: "none" });
    codexDeviceAuthStart.mockResolvedValue({
      id: "auth-1",
      projectId: "project-1",
      accountId: "account-1",
      codexHome: "/tmp/.codex",
      state: "pending",
      verificationUrl: "https://chatgpt.com/device",
      userCode: "ABCD-EFGH",
      output: "",
      startedAt: 1,
      updatedAt: 1,
    });

    render(<CodexCredentialsPanel embedded defaultProjectId="project-1" />);

    await waitFor(() => {
      expect(screen.getByText("Codex is not connected yet.")).toBeTruthy();
    });
    expect(screen.queryByText("Start device login")).toBeNull();

    await act(async () => {
      screen.getByText("Sign in with ChatGPT").click();
    });

    await waitFor(() => {
      expect(screen.queryByText("Start device login")).toBeNull();
      expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
      expect(
        screen.getByText((text) =>
          text.includes("Finish signing in with ChatGPT"),
        ),
      ).toBeTruthy();
    });
  });

  it("shows the device login panel while waiting for the start RPC", async () => {
    getCodexPaymentSource.mockResolvedValue({ source: "none" });
    const started = deferred<any>();
    codexDeviceAuthStart.mockReturnValue(started.promise);

    render(<CodexCredentialsPanel embedded defaultProjectId="project-1" />);

    await waitFor(() => {
      expect(screen.getByText("Codex is not connected yet.")).toBeTruthy();
    });

    await act(async () => {
      screen.getByText("Sign in with ChatGPT").click();
    });

    expect(
      screen.getByText((text) =>
        text.includes("Getting your one-time sign-in code"),
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Start device login")).toBeNull();

    await act(async () => {
      started.resolve({
        id: "auth-1",
        projectId: "project-1",
        accountId: "account-1",
        codexHome: "/tmp/.codex",
        state: "pending",
        verificationUrl: "https://chatgpt.com/device",
        userCode: "ABCD-EFGH",
        output: "",
        startedAt: 1,
        updatedAt: 1,
      });
      await started.promise;
    });

    await waitFor(() => {
      expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    });
  });

  it("shows device login instructions parsed from raw Codex output", async () => {
    getCodexPaymentSource.mockResolvedValue({ source: "none" });
    codexDeviceAuthStart.mockResolvedValue({
      id: "auth-1",
      projectId: "project-1",
      accountId: "account-1",
      codexHome: "/tmp/.codex",
      state: "pending",
      output:
        "Open https://chatgpt.com/device and enter this one-time code\nWXYZ-1234",
      startedAt: 1,
      updatedAt: 1,
    });

    render(<CodexCredentialsPanel embedded defaultProjectId="project-1" />);

    await waitFor(() => {
      expect(screen.getByText("Codex is not connected yet.")).toBeTruthy();
    });

    await act(async () => {
      screen.getByText("Sign in with ChatGPT").click();
    });

    await waitFor(() => {
      expect(screen.getByText("WXYZ-1234")).toBeTruthy();
      expect(screen.getByText("Copy URL")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("1. Copy this one-time code"));
    await waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith("WXYZ-1234");
    });
  });
});
