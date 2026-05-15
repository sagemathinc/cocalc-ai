import { fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "antd";
import { Map as ImmutableMap } from "immutable";
import * as React from "react";
import { IntlProvider } from "react-intl";
import { StartButton } from "./start-button";

const mockStartProject = jest.fn();
const mockSetProjectRuntimeSponsorToMe = jest.fn();
let mockAccountId: string | undefined;
let mockIsAdmin = false;

let projectMap = ImmutableMap({
  "project-1": ImmutableMap({
    state: ImmutableMap({
      state: "closed",
    }),
  }),
});

let startLroRecord: any = {
  toJS: () => ({
    summary: {
      status: "running",
      op_id: "op-1",
      scope_type: "project",
      scope_id: "project-1",
    },
  }),
};

jest.mock("antd", () => {
  const Div = ({ children, size, align, wrap, ...props }: any) => (
    <div {...props}>{children}</div>
  );
  const Button = ({ children, danger, size, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  );
  return {
    Alert: ({ title, description, children }: any) => (
      <div>
        {title}
        {description}
        {children}
      </div>
    ),
    Button,
    Modal: {
      confirm: jest.fn(),
      error: jest.fn(),
    },
    Progress: Div,
    Space: Div,
    Spin: Div,
  };
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({
      start_project: mockStartProject,
      set_project_runtime_sponsor_to_me: mockSetProjectRuntimeSponsorToMe,
    }),
    getStore: () =>
      ImmutableMap({
        is_admin: false,
      }),
  },
  useMemo: React.useMemo,
  useTypedRedux: (_opts: any, key: string) => {
    if (key === "project_map") return projectMap;
    if (key === "account_id") return mockAccountId;
    if (key === "is_admin") return mockIsAdmin;
    if (key === "start_lro") return startLroRecord;
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  A: ({ children, href }: any) => <a href={href}>{children}</a>,
  Icon: ({ name }: any) => <span data-testid={`icon-${name}`} />,
  ProjectState: () => <span>Project is stopped</span>,
  Tooltip: ({ title, children }: any) => (
    <div>
      <div>{title}</div>
      <div>{children}</div>
    </div>
  ),
  VisibleMDLG: ({ children }: any) => <>{children}</>,
}));

jest.mock("./context", () => ({
  useProjectContext: () => ({
    project_id: "project-1",
    is_active: true,
  }),
}));

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

jest.mock("@cocalc/frontend/projects/host-info", () => ({
  useHostInfo: () => undefined,
}));

jest.mock("@cocalc/frontend/projects/project-title", () => ({
  ProjectTitle: ({ project_id }: { project_id: string }) => (
    <span>{project_id}</span>
  ),
}));

jest.mock("@cocalc/frontend/projects/host-operational", () => ({
  evaluateHostOperational: () => ({
    state: "available",
  }),
  hostLabel: () => "Host",
  normalizeProjectStateForDisplay: ({ projectState }: any) => projectState,
}));

jest.mock("@cocalc/frontend/project/settings/move-project", () => () => null);

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        lro: {
          dismiss: jest.fn(),
        },
      },
    },
  },
}));

jest.mock("./use-project-active-op", () => ({
  useProjectActiveOperation: () => ({
    activeOp: undefined,
  }),
}));

describe("StartButton", () => {
  beforeEach(() => {
    mockStartProject.mockReset();
    mockSetProjectRuntimeSponsorToMe.mockReset();
    (Modal.confirm as jest.Mock).mockReset();
    mockAccountId = undefined;
    mockIsAdmin = false;
    startLroRecord = {
      toJS: () => ({
        summary: {
          status: "running",
          op_id: "op-1",
          scope_type: "project",
          scope_id: "project-1",
        },
      }),
    };
    projectMap = ImmutableMap({
      "project-1": ImmutableMap({
        state: ImmutableMap({
          state: "closed",
        }),
      }),
    });
  });

  it("does not render legacy LRO or bootlog diagnostics inside the start tooltip", () => {
    render(
      <IntlProvider locale="en">
        <StartButton />
      </IntlProvider>,
    );

    expect(
      screen.getByRole("button", { name: /starting project/i }),
    ).toBeTruthy();
    expect(screen.queryByText(/LRO:/i)).toBeNull();
    expect(screen.queryByText(/bootlog/i)).toBeNull();
  });

  it("asks a collaborator to sponsor before starting when sponsor starts are blocked", () => {
    mockAccountId = "user-1";
    startLroRecord = undefined;
    projectMap = ImmutableMap({
      "project-1": ImmutableMap({
        allow_collaborator_starts_using_sponsor: false,
        state: ImmutableMap({
          state: "closed",
        }),
        users: ImmutableMap({
          "owner-1": ImmutableMap({ group: "owner" }),
          "user-1": ImmutableMap({ group: "collaborator" }),
        }),
      }),
    });

    render(
      <IntlProvider locale="en">
        <StartButton />
      </IntlProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /start project/i }));

    expect(Modal.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Use your membership to start this project?",
        okText: "Use my membership and start",
      }),
    );
    expect(mockStartProject).not.toHaveBeenCalled();
  });
});
