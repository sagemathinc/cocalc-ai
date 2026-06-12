import immutable from "immutable";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SSHPanel } from "./ssh";

const useHostInfo = jest.fn();
const useTypedRedux = jest.fn();
const apiKeys = jest.fn();

jest.mock("antd", () => {
  const Text = ({ children }: any) => <span>{children}</span>;
  const Paragraph = ({ children }: any) => <p>{children}</p>;
  const Button = ({ children, onClick, loading }: any) => (
    <button type="button" onClick={onClick} disabled={loading}>
      {children}
    </button>
  );
  const Modal = ({ children, open, title }: any) =>
    open ? (
      <div role="dialog">
        <h2>{title}</h2>
        {children}
      </div>
    ) : null;
  const Space = ({ children }: any) => <div>{children}</div>;
  const Alert = ({ description, message }: any) => (
    <div>
      {message}
      {description}
    </div>
  );
  return {
    Alert,
    Button,
    Modal,
    Space,
    Tooltip: ({ children }: any) => <>{children}</>,
    Typography: {
      Text,
      Paragraph,
    },
  };
});

jest.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: ({ defaultMessage, id }: any) => defaultMessage ?? id ?? "",
  }),
}));

jest.mock("@cocalc/frontend/account/ssh-keys/ssh-key-list", () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: () => ({
      open_file: jest.fn(),
    }),
  },
  useTypedRedux: (...args: any[]) => useTypedRedux(...args),
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => {
  const React = require("react");
  const isFreshAuthRequiredError = (err: unknown) =>
    `${(err as any)?.code ?? ""}` === "fresh_auth_required" ||
    `${(err as any)?.message ?? err ?? ""}`
      .toLowerCase()
      .includes("fresh auth");
  return {
    FreshAuthModal: ({ open, onSuccess }: any) =>
      open ? (
        <button type="button" onClick={onSuccess}>
          Verify fresh auth
        </button>
      ) : null,
    useFreshAuthAction: () => {
      const [open, setOpen] = React.useState(false);
      const pendingActionRef = React.useRef<null | {
        action: () => Promise<void>;
        resolve: (completed: boolean) => void;
        reject: (err: unknown) => void;
      }>(null);
      return {
        runFreshAuthAction: async (action: () => Promise<void>) => {
          try {
            await action();
            return true;
          } catch (err) {
            if (!isFreshAuthRequiredError(err)) {
              throw err;
            }
            return await new Promise<boolean>((resolve, reject) => {
              pendingActionRef.current = { action, resolve, reject };
              setOpen(true);
            });
          }
        },
        freshAuthModalProps: {
          open,
          onCancel: () => {
            const pending = pendingActionRef.current;
            pendingActionRef.current = null;
            pending?.resolve(false);
            setOpen(false);
          },
          onSuccess: async () => {
            const pending = pendingActionRef.current;
            pendingActionRef.current = null;
            if (!pending) return;
            setOpen(false);
            try {
              await pending.action();
              pending.resolve(true);
            } catch (err) {
              pending.reject(err);
            }
          },
        },
      };
    },
  };
});

jest.mock("@cocalc/frontend/components", () => ({
  A: ({ children, href }: any) => <a href={href}>{children}</a>,
  CopyToClipBoard: ({ value }: any) => <div>{value}</div>,
  Icon: () => null,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/components/copy-button", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("react-copy-to-clipboard", () => ({
  CopyToClipboard: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    project: { defaultMessage: "Project" },
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "acct-1",
    account_client: {
      api_keys: (...args: any[]) => apiKeys(...args),
    },
  },
}));

jest.mock("@cocalc/frontend/projects/host-info", () => ({
  useHostInfo: (...args: any[]) => useHostInfo(...args),
}));

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

describe("SSHPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    apiKeys.mockResolvedValue([{ secret: "sk-test-secret" }]);
    useTypedRedux.mockImplementation((_store: string, key: string) => {
      if (key === "is_launchpad") return true;
      return undefined;
    });
  });

  it("shows CoCalc CLI install and generated ssh setup command for launchpad projects", async () => {
    useHostInfo.mockReturnValue(
      immutable.Map({
        ssh_server: "hub.example.com:2200",
        local_proxy: false,
      }),
    );

    render(
      <SSHPanel
        project={
          immutable.fromJS({
            project_id: "project-1",
            users: {
              "acct-1": {
                ssh_keys: [],
              },
            },
          }) as any
        }
        mode="flyout"
      />,
    );

    expect(
      screen.getByText(/Launchpad SSH is routed through Cloudflare/i),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "curl -fsSL https://software.cocalc.ai/software/cocalc/install.sh | bash",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "CoCalc CLI" }).getAttribute("href"),
    ).toBe("https://software.cocalc.ai/software/cocalc/index.html");
    expect(screen.queryByText(/SSH target:/i)).toBeNull();
    expect(screen.queryByText(/Docs/i)).toBeNull();
    expect(screen.queryByText(/must be running/i)).toBeNull();
    expect(screen.queryByText(/<account-api-key>/i)).toBeNull();
    expect(screen.getByText(/Need scp or sftp help/i)).toBeTruthy();

    fireEvent.click(screen.getByText(/Need scp or sftp help/i));
    expect(screen.getByText("scp ./local-file project-1:~/")).toBeTruthy();
    expect(screen.getByText("scp project-1:~/remote-file ./")).toBeTruthy();
    expect(
      screen.getByText(
        "apt-get update; apt-get install -y openssh-sftp-server",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Generate setup command"));

    await waitFor(() => {
      expect(apiKeys).toHaveBeenCalledWith({
        action: "create",
        name: "SSH setup for project-1",
        expire: expect.any(Date),
        capabilities: ["project:exec"],
        allowed_project_ids: ["project-1"],
      });
    });
    expect(
      screen.getByText(
        "COCALC_API_KEY='sk-test-secret' cocalc --api 'http://localhost' project ssh-config add -w 'project-1'",
      ),
    ).toBeTruthy();
    expect(screen.getByText("ssh project-1")).toBeTruthy();
    expect(
      screen.getAllByText("scp ./local-file project-1:~/").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("scp project-1:~/remote-file ./").length,
    ).toBeGreaterThan(0);
  });

  it("requests fresh auth before retrying ssh setup API key creation", async () => {
    useHostInfo.mockReturnValue(
      immutable.Map({
        ssh_server: "hub.example.com:2200",
        local_proxy: false,
      }),
    );
    apiKeys
      .mockRejectedValueOnce(
        Object.assign(new Error("fresh auth is required"), {
          code: "fresh_auth_required",
        }),
      )
      .mockResolvedValueOnce([{ secret: "sk-after-fresh-auth" }]);

    render(
      <SSHPanel
        project={
          immutable.fromJS({
            project_id: "project-1",
            users: {
              "acct-1": {
                ssh_keys: [],
              },
            },
          }) as any
        }
        mode="flyout"
      />,
    );

    fireEvent.click(screen.getByText("Generate setup command"));

    await waitFor(() => {
      expect(screen.getByText("Verify fresh auth")).toBeTruthy();
    });
    expect(apiKeys).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Verify fresh auth"));

    await waitFor(() => {
      expect(apiKeys).toHaveBeenCalledTimes(2);
      expect(
        screen.getByText(
          "COCALC_API_KEY='sk-after-fresh-auth' cocalc --api 'http://localhost' project ssh-config add -w 'project-1'",
        ),
      ).toBeTruthy();
    });
  });
});
