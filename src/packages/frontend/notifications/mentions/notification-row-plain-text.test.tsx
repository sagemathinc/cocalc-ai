/** @jest-environment jsdom */

import React from "react";
import { render } from "@testing-library/react";
import { fromJS } from "immutable";
import { NotificationRow } from "./notification-row";

const open_file = jest.fn();
const mockSetNotificationsOpen = jest.fn();
jest.mock("../drawer-state", () => ({
  setNotificationsOpen: (...args: any[]) => mockSetNotificationsOpen(...args),
}));
const mark = jest.fn();
const markMany = jest.fn();
const respondAccessRequest = jest.fn();
const listAccessRequests = jest.fn();
const mockEnsureProjectReduxRuntime = jest.fn();
const mockOpenAgentNotification = jest.fn();
const listConversations = jest.fn();
const setState = jest.fn();
const set_active_tab = jest.fn();

jest.mock("../../agents/open-notification", () => ({
  openAgentNotification: (...args: any[]) => mockOpenAgentNotification(...args),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => undefined,
    getProjectActions: () => ({ open_file }),
    getActions: () => ({ mark, markMany, setState, set_active_tab }),
  },
}));

jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: () => mockEnsureProjectReduxRuntime(),
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

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        people: {
          listConversations: (...args: any[]) => listConversations(...args),
        },
      },
    },
    project_collaborators: {
      respond_access_request: (...args: any[]) => respondAccessRequest(...args),
      list_access_requests: (...args: any[]) => listAccessRequests(...args),
    },
  },
}));

// A message from someone not yet accepted is plain text: the real renderer
// must show it literally, whatever Markdown, linkify, checkbox or math syntax
// it contains (direct conversations, PR #1459).
const HOSTILE = [
  "http://2130706433:3000/admin",
  "http://localhost:3000/admin",
  "[x] approved",
  "https://raw.example/pixel",
  "![probe](https://attacker.example/pixel)",
  "[link](https://x.example)",
  "<img src=x> <b>bold</b>",
  "\\(x^2\\) and $y$ and \\[z\\]",
].join("\n");

function renderNotice(fields: Record<string, string>) {
  return render(
    <NotificationRow
      id="notice-1"
      user_map={{}}
      mention={
        fromJS({
          kind: "account_notice",
          target: "account-1",
          time: new Date("2026-10-28T00:00:00.000Z"),
          title: "Bea sent you a message request",
          origin_label: "Messages",
          notice_type: "direct_message",
          users: { "account-1": { read: false, saved: false } },
          ...fields,
        }) as any
      }
    />,
  );
}

const ACTIVE =
  "a[href], img, input, .katex, math, b, script, iframe, [contenteditable]";

describe("plain-text notification bodies", () => {
  it("shows body_text literally, with nothing that links, loads or renders", () => {
    const { container } = renderNotice({ body_text: HOSTILE });
    const body = [...container.querySelectorAll("div")].find(
      (el) => el.textContent === HOSTILE,
    );
    expect(body).toBeDefined();
    expect(body!.children).toHaveLength(0);
    expect(container.querySelectorAll(ACTIVE)).toHaveLength(0);
  });

  it("(control) the same text as Markdown does render links and checkboxes", () => {
    const { container } = renderNotice({ body_markdown: HOSTILE });
    expect(container.querySelectorAll("a[href]").length).toBeGreaterThan(0);
    expect(container.querySelector("input")).not.toBeNull();
  });
});
