import { act, render, screen, waitFor } from "@testing-library/react";
import { CodexCredentialsPanel } from "./codex-credentials-panel";

const getCodexPaymentSource = jest.fn();
const codexDeviceAuthStart = jest.fn();

jest.mock("antd", () => {
  const Button = ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
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
  const Collapse = ({ children, items }: any) => (
    <div>
      {items?.map((item: any) => (
        <div key={item.key}>
          {item.label}
          {item.children}
        </div>
      ))}
      {children}
    </div>
  );
  return {
    Alert: Div,
    Button,
    Collapse,
    Input: () => null,
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
      expect(screen.getByText("ChatGPT Plan")).toBeTruthy();
    });

    rerender(<CodexCredentialsPanel embedded defaultProjectId="project-2" />);

    await waitFor(() => {
      expect(screen.queryByText("ChatGPT Plan")).toBeNull();
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
      screen.getByText("Start device login").click();
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
});
