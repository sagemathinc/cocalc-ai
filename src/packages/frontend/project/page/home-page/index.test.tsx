import { render, screen } from "@testing-library/react";
import HomePage from "./index";

const mockStartButton = jest.fn(({ minimal }: { minimal?: boolean }) => (
  <div data-testid="start-button" data-minimal={String(!!minimal)} />
));

jest.mock("antd", () => ({
  Alert: ({ children, description, message, style }: any) => (
    <div data-testid="lifecycle-alert" style={style}>
      <div>{message}</div>
      <div>{description}</div>
      {children}
    </div>
  ),
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Col: ({ children }: any) => <div>{children}</div>,
  Row: ({ children, style }: any) => <div style={style}>{children}</div>,
  Space: {
    Compact: ({ children }: any) => <div>{children}</div>,
  },
}));

jest.mock("react-intl", () => ({
  ...jest.requireActual("react-intl"),
  FormattedMessage: ({ defaultMessage }: any) => <>{defaultMessage}</>,
}));

jest.mock("@cocalc/frontend/app/use-context", () => ({
  __esModule: true,
  default: () => ({
    displayI18N: (value: string) => value,
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({
      start_project: jest.fn(),
    }),
  },
  useTypedRedux: (store: string, key: string) => {
    if (store === "account" && key === "other_settings") {
      return undefined;
    }
    if (store === "projects" && key === "project_map") {
      return {
        getIn: () => undefined,
      };
    }
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span>{name}</span>,
  Title: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({
    project_id: "project-1",
    actions: {
      set_active_tab: jest.fn(),
    },
  }),
}));

jest.mock("@cocalc/frontend/project/start-button", () => ({
  StartButton: (props: any) => mockStartButton(props),
}));

jest.mock("@cocalc/frontend/projects/host-operational", () => ({
  getProjectLifecycleView: () => ({
    kind: "closed",
    showLifecycleBanner: true,
  }),
}));

jest.mock("@cocalc/frontend/projects/project-title", () => ({
  ProjectTitle: () => <div>Project</div>,
}));

jest.mock("../file-tab", () => ({
  FIXED_PROJECT_TABS: {
    new: { icon: "plus", label: "New" },
    files: { icon: "folder-open", label: "Files" },
    log: { icon: "history", label: "Log" },
    users: { icon: "users", label: "Users" },
    settings: { icon: "settings", label: "Settings" },
  },
}));

jest.mock("../../new/navigator-shell", () => ({
  NavigatorShell: () => null,
}));

jest.mock("./recent-files", () => ({
  HomeRecentFiles: () => null,
}));

describe("HomePage", () => {
  beforeEach(() => {
    mockStartButton.mockClear();
  });

  it("uses the compact start button inside a full-width lifecycle alert", () => {
    render(<HomePage />);

    expect(screen.getByTestId("start-button")).toHaveAttribute(
      "data-minimal",
      "true",
    );
    expect(screen.getByTestId("lifecycle-alert")).toHaveStyle({
      width: "100%",
    });
  });
});
