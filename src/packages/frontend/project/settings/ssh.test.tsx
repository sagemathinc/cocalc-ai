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
});
