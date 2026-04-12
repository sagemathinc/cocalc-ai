import immutable from "immutable";
import { render, screen } from "@testing-library/react";
import { SSHPanel } from "./ssh";

const useHostInfo = jest.fn();

jest.mock("antd", () => {
  const Text = ({ children }: any) => <span>{children}</span>;
  const Paragraph = ({ children }: any) => <p>{children}</p>;
  const Button = ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  );
  return {
    Button,
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
}));

jest.mock("@cocalc/frontend/components", () => ({
  A: ({ children, href }: any) => <a href={href}>{children}</a>,
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
  });

  it("shows CoCalc CLI install and ssh instructions for hub-routed workspaces", () => {
    useHostInfo.mockReturnValue(
      immutable.Map({
        ssh_server: "hub.example.com:2200",
        local_proxy: true,
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
      screen.getByText(/For workspace SSH from your machine, install the/i),
    ).toBeTruthy();
    expect(screen.getByText("cocalc project ssh -w project-1")).toBeTruthy();
    expect(
      screen.getByText(
        "curl -fsSL https://software.cocalc.ai/software/cocalc/install.sh | bash",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "CoCalc CLI" }).getAttribute("href"),
    ).toBe("https://software.cocalc.ai/software/cocalc/install.sh");
  });
});
