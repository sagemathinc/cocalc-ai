/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  IncomingInvitesNotificationSection,
  type InviteInboxState,
} from "./invite-inbox";

const ensureRealtimeFeedForCurrentAccount = jest.fn(async () => undefined);
const openProject = jest.fn(async () => undefined);

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    React,
    redux: {
      getActions: (name: string) => {
        if (name === "projects") {
          return {
            ensureRealtimeFeedForCurrentAccount,
            open_project: openProject,
          };
        }
        return {};
      },
    },
    useCallback: React.useCallback,
    useEffect: React.useEffect,
    useMemo: React.useMemo,
    useState: React.useState,
    useTypedRedux: jest.fn(),
  };
});

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span>{name}</span>,
  Loading: () => <span>Loading</span>,
  Markdown: ({ value }: any) => <span>{value}</span>,
  Paragraph: ({ children }: any) => <p>{children}</p>,
  TimeAgo: () => <span>time</span>,
}));

jest.mock("./invite-count", () => ({
  setUnreadIncomingInviteCount: jest.fn(),
}));

jest.mock("./invite-events", () => ({
  notifyCollabInvitesChanged: jest.fn(),
  onCollabInvitesChanged: jest.fn(() => jest.fn()),
}));

jest.mock("./viewer-read-policy", () => ({
  viewerReadPolicySummary: () => "All files",
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    project_collaborators: {
      list_invites: jest.fn(async () => []),
      list_invite_blocks: jest.fn(async () => []),
      respond_invite: jest.fn(async () => undefined),
    },
  },
}));

describe("IncomingInvitesNotificationSection", () => {
  beforeEach(() => {
    ensureRealtimeFeedForCurrentAccount.mockClear();
    openProject.mockClear();
  });

  it("keeps accepted invite feedback visible with an open project action", async () => {
    const respond = jest.fn(async () => true);
    const state: InviteInboxState = {
      loading: false,
      error: "",
      busy: "",
      incoming: [
        {
          invite_id: "invite-1",
          project_id: "project-1",
          project_title: "Demo Project",
          inviter_account_id: "inviter-1",
          inviter_name: "Grace Hopper",
          invite_role: "collaborator",
          created: new Date("2026-05-30T00:00:00.000Z"),
        } as any,
      ],
      outgoing: [],
      blocks: [],
      load: jest.fn(async () => undefined),
      respond,
      copyInviteLink: jest.fn(async () => undefined),
      unblock: jest.fn(async () => undefined),
    };

    render(<IncomingInvitesNotificationSection state={state} />);

    fireEvent.click(screen.getByText("Accept"));

    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("invite-1", "accept"),
    );
    expect(await screen.findByText("Joined Demo Project")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Open project"));

    await waitFor(() =>
      expect(openProject).toHaveBeenCalledWith({
        project_id: "project-1",
        target: "files",
        switch_to: true,
        restore_session: false,
      }),
    );
    expect(ensureRealtimeFeedForCurrentAccount).toHaveBeenCalled();
  });
});
