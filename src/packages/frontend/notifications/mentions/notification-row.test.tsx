/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fromJS } from "immutable";
import { NotificationRow } from "./notification-row";

const open_file = jest.fn();
const mark = jest.fn();
const markMany = jest.fn();
const respondAccessRequest = jest.fn();
const listAccessRequests = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: () => ({ open_file }),
    getActions: () => ({ mark, markMany }),
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  A: ({ children, href, onClick }: any) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
  Icon: ({ name }: any) => <span>{name}</span>,
  TimeAgo: () => <span>time</span>,
}));

jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: () => <span>avatar</span>,
}));

jest.mock("@cocalc/frontend/projects/project-title", () => ({
  ProjectTitle: ({ project_id }: any) => <span>{project_id}</span>,
}));

jest.mock("@cocalc/frontend/users", () => ({
  User: ({ account_id }: any) => <span>{account_id}</span>,
}));

jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }: any) => <span>{value}</span>,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    project_collaborators: {
      respond_access_request: (...args: any[]) => respondAccessRequest(...args),
      list_access_requests: (...args: any[]) => listAccessRequests(...args),
    },
  },
}));

describe("NotificationRow", () => {
  beforeEach(() => {
    open_file.mockReset();
    mark.mockReset();
    markMany.mockReset();
    respondAccessRequest.mockReset();
    respondAccessRequest.mockResolvedValue(undefined);
    listAccessRequests.mockReset();
    listAccessRequests.mockResolvedValue([]);
  });

  it("does not mark account notices read when they do not target a file", () => {
    render(
      <NotificationRow
        id="notice-1"
        user_map={{}}
        mention={
          fromJS({
            kind: "account_notice",
            target: "acct-1",
            time: new Date("2026-05-07T00:00:00.000Z"),
            title: "Codex turn finished",
            body_markdown: "done",
            origin_label: "Codex",
            fragment_id: "chat=1234",
            users: { "acct-1": { read: false, saved: false } },
          }) as any
        }
      />,
    );

    fireEvent.click(screen.getByText("Codex turn finished"));

    expect(open_file).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
    expect(markMany).not.toHaveBeenCalled();
  });

  it("opens file-target notifications and marks them read", () => {
    render(
      <NotificationRow
        id="notice-1"
        user_map={{}}
        mention={
          fromJS({
            kind: "account_notice",
            project_id: "project-1",
            path: "work/chat.chat",
            target: "acct-1",
            time: new Date("2026-05-07T00:00:00.000Z"),
            title: "Codex turn finished",
            body_markdown: "done",
            origin_label: "Codex",
            fragment_id: "chat=1234",
            users: { "acct-1": { read: false, saved: false } },
          }) as any
        }
      />,
    );

    fireEvent.click(screen.getByText("Codex turn finished"));

    expect(open_file).toHaveBeenCalledWith({
      path: "work/chat.chat",
      chat: true,
      fragmentId: { chat: "1234" },
    });
    expect(mark).toHaveBeenCalledWith(expect.anything(), "notice-1", "read");
    expect(markMany).not.toHaveBeenCalled();
  });

  it("does not mark account notices read when clicking action links", () => {
    render(
      <NotificationRow
        id="notice-1"
        user_map={{}}
        mention={
          fromJS({
            kind: "account_notice",
            target: "acct-1",
            time: new Date("2026-05-07T00:00:00.000Z"),
            title: "Billing notice",
            body_markdown: "Review billing details",
            action_link: "/hosts",
            action_label: "Open dedicated hosts",
            users: { "acct-1": { read: false, saved: false } },
          }) as any
        }
      />,
    );

    fireEvent.click(screen.getByText("Open dedicated hosts"));

    expect(mark).not.toHaveBeenCalled();
    expect(markMany).not.toHaveBeenCalled();
  });

  it("shows grouped account notice counts and marks all grouped notices", () => {
    render(
      <NotificationRow
        id="notice-1"
        groupedIds={["notice-1", "notice-2"]}
        groupCount={2}
        firstTime={new Date("2026-05-07T00:00:00.000Z")}
        latestTime={new Date("2026-05-07T00:10:00.000Z")}
        user_map={{}}
        mention={
          fromJS({
            kind: "account_notice",
            project_id: "project-1",
            path: "work/chat.chat",
            target: "acct-1",
            time: new Date("2026-05-07T00:10:00.000Z"),
            title: "Codex turn finished",
            body_markdown: "done",
            origin_label: "Codex",
            users: { "acct-1": { read: false, saved: false } },
          }) as any
        }
      />,
    );

    expect(screen.getByText("2 times")).toBeInTheDocument();
    expect(screen.getByText(/Received from/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Mark Read"));

    expect(markMany).toHaveBeenCalledWith(["notice-1", "notice-2"], "read");
    expect(mark).not.toHaveBeenCalled();
  });

  it("reviews project access requests inline instead of opening the project settings page", async () => {
    listAccessRequests.mockResolvedValue([
      {
        request_id: "request-1",
        status: "pending",
      },
    ]);
    render(
      <NotificationRow
        id="notice-1"
        user_map={{}}
        mention={
          fromJS({
            kind: "account_notice",
            project_id: "project-1",
            target: "approver-1",
            time: new Date("2026-05-07T00:00:00.000Z"),
            title: "Bella requested collaborator access",
            body_markdown: "Bella requested collaborator access.",
            origin_label: "Project access",
            notice_type: "project_access_request",
            request_id: "request-1",
            requested_role: "collaborator",
            action_link: "/projects/project-1/settings",
            action_label: "Review request",
            users: { "approver-1": { read: false, saved: false } },
          }) as any
        }
      />,
    );

    expect(screen.queryByText("Review request")).toBeNull();

    fireEvent.click(await screen.findByText("Approve collaborator"));

    await waitFor(() =>
      expect(respondAccessRequest).toHaveBeenCalledWith({
        project_id: "project-1",
        request_id: "request-1",
        action: "approve",
        role: "collaborator",
      }),
    );
    expect(mark).toHaveBeenCalledWith(expect.anything(), "notice-1", "read");
    expect(screen.getByText("Approved collaborator access.")).toBeTruthy();
  });

  it("shows completed project access requests without stale action buttons", async () => {
    listAccessRequests.mockResolvedValue([
      {
        request_id: "request-1",
        status: "approved",
      },
    ]);
    render(
      <NotificationRow
        id="notice-1"
        user_map={{}}
        mention={
          fromJS({
            kind: "account_notice",
            project_id: "project-1",
            target: "approver-1",
            time: new Date("2026-05-07T00:00:00.000Z"),
            title: "Bella requested collaborator access",
            body_markdown: "Bella requested collaborator access.",
            origin_label: "Project access",
            notice_type: "project_access_request",
            request_id: "request-1",
            requested_role: "collaborator",
            action_link: "/projects/project-1/settings",
            action_label: "Review request",
            users: { "approver-1": { read: false, saved: false } },
          }) as any
        }
      />,
    );

    expect(
      await screen.findByText("Access request already approved."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Approve collaborator")).toBeNull();
    expect(screen.queryByText("Deny")).toBeNull();
    expect(respondAccessRequest).not.toHaveBeenCalled();
  });
});
