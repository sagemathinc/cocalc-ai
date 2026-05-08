/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { fromJS } from "immutable";
import { NotificationRow } from "./notification-row";

const open_file = jest.fn();
const mark = jest.fn();
const markMany = jest.fn();

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

describe("NotificationRow", () => {
  beforeEach(() => {
    open_file.mockReset();
    mark.mockReset();
    markMany.mockReset();
  });

  it("opens account notices that target a chat location", () => {
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
    expect(mark).toHaveBeenCalled();
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
});
