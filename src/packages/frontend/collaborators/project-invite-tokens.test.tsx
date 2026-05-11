import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectInviteTokens } from "./project-invite-tokens";
import { alert_message } from "@cocalc/frontend/alerts";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("antd", () => {
  const Button = ({ children, onClick, disabled }: any) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
  const Card = ({ children }: any) => <div>{children}</div>;
  const DatePicker = () => <input />;
  const Form = ({ children }: any) => <form>{children}</form>;
  Form.Item = ({ children }: any) => <div>{children}</div>;
  Form.useForm = () => [
    {
      getFieldValue: jest.fn(() => ({ toDate: () => new Date() })),
      resetFields: jest.fn(),
    },
  ];
  const Modal = ({ children, open }: any) =>
    open ? <div>{children}</div> : null;
  const Popconfirm = ({ children }: any) => <>{children}</>;
  const Table = ({ dataSource }: any) => (
    <div data-testid="token-table">{dataSource.length}</div>
  );
  return {
    Button,
    Card,
    DatePicker,
    Form,
    Modal,
    Popconfirm,
    Table,
  };
});

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: jest.fn(),
}));

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    React,
    useState: React.useState,
    useIsMountedRef: () => {
      const mounted = React.useRef(true);
      React.useEffect(
        () => () => {
          mounted.current = false;
        },
        [],
      );
      return mounted;
    },
  };
});

jest.mock("@cocalc/frontend/components", () => ({
  CopyToClipBoard: ({ value }: any) => <span>{value}</span>,
  ErrorDisplay: ({ error, onClose }: any) => (
    <div role="alert">
      {error}
      {onClose ? (
        <button type="button" onClick={onClose}>
          close
        </button>
      ) : null}
    </div>
  ),
  Gap: () => <span />,
  Icon: ({ name }: any) => <span>{name}</span>,
  Loading: () => <div>Loading...</div>,
  TimeAgo: ({ date }: any) => <span>{`${date}`}</span>,
}));

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "",
}));

jest.mock("@cocalc/frontend/i18n/components", () => ({
  CancelText: () => <>Cancel</>,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    async_query: jest.fn(),
    server_time: jest.fn(() => new Date("2026-05-11T00:00:00.000Z")),
  },
}));

jest.mock("./handle-project-invite", () => ({
  PROJECT_INVITE_QUERY_PARAM: "invite",
}));

describe("ProjectInviteTokens", () => {
  const asyncQueryMock = webapp_client.async_query as jest.Mock;
  const alertMessageMock = alert_message as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not leave the token list loading forever after the initial fetch fails", async () => {
    asyncQueryMock.mockRejectedValueOnce(
      new Error('once: "connected" not emitted before "closed"'),
    );

    render(<ProjectInviteTokens project_id="project-1" />);

    fireEvent.click(
      screen.getByText("Invite collaborators by sending them an invite URL..."),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        'Error getting project invite tokens: Error: once: "connected" not emitted before "closed"',
      );
    });
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(alertMessageMock).toHaveBeenCalledWith({
      type: "error",
      message:
        'Error getting project invite tokens: Error: once: "connected" not emitted before "closed"',
    });
  });

  it("does not return to a loading spinner when dismissing an initial fetch error", async () => {
    asyncQueryMock.mockRejectedValueOnce(new Error("network offline"));

    render(<ProjectInviteTokens project_id="project-1" />);

    fireEvent.click(
      screen.getByText("Invite collaborators by sending them an invite URL..."),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Error getting project invite tokens: Error: network offline",
      );
    });

    fireEvent.click(screen.getByText("close"));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.getByTestId("token-table")).toHaveTextContent("0");
  });
});
