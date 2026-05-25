import { act, render, screen, waitFor } from "@testing-library/react";
import { CodexCredentialsPanel } from "./codex-credentials-panel";

const getCodexPaymentSource = jest.fn();
const codexDeviceAuthStart = jest.fn();
const codexDeviceAuthStatus = jest.fn();

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
  return {
    Alert: Div,
    Button,
    Collapse,
    Input: { TextArea },
    Popconfirm: Div,
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
  TimeAgo: () => null,
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
  });

  it("clears the previous payment source label immediately when the project changes", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    getCodexPaymentSource
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

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
      expect(screen.getByText("Not configured")).toBeTruthy();
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
      expect(screen.getByText("Not configured")).toBeTruthy();
    });

    await act(async () => {
      screen.getByText("Sign in with ChatGPT").click();
    });

    await waitFor(() => {
      expect(
        screen.getByText((text) =>
          text.includes("Device auth status: pending"),
        ),
      ).toBeTruthy();
    });

    rerender(<CodexCredentialsPanel embedded defaultProjectId="project-2" />);

    await waitFor(() => {
      expect(
        screen.queryByText((text) =>
          text.includes("Device auth status: pending"),
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
      expect(screen.getByText("Not configured")).toBeTruthy();
    });

    await act(async () => {
      screen.getByText("Sign in with ChatGPT").click();
    });

    await waitFor(() => {
      expect(
        screen.getByText((text) =>
          text.includes("Device auth status: pending"),
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

  it("opens the ChatGPT subscription panel when sign-in starts", async () => {
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
      expect(screen.getByText("Not configured")).toBeTruthy();
    });
    expect(screen.queryByText("Start device login")).toBeNull();

    await act(async () => {
      screen.getByText("Sign in with ChatGPT").click();
    });

    await waitFor(() => {
      expect(screen.getByText("Start device login")).toBeTruthy();
      expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
      expect(
        screen.getByText((text) =>
          text.includes("Device auth status: pending"),
        ),
      ).toBeTruthy();
    });
  });
});
