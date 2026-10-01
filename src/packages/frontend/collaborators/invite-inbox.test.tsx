/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  IncomingInviteBanner,
  IncomingInvitesNotificationSection,
  useInviteInboxState,
  type InviteInboxState,
} from "./invite-inbox";
import {
  getUnreadIncomingInviteCount,
  setUnreadIncomingInviteCount,
  subscribeUnreadIncomingInviteCount,
} from "./invite-count";

const ensureRealtimeFeedForCurrentAccount = jest.fn(async () => undefined);
const openProject = jest.fn(async () => undefined);
const listInvites = jest.fn();
const getInvitationCounts = jest.fn();
let mockAccountId: string | undefined = "account-1";
let mockCollaboratorsEnabled = true;

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
    useProjectMapField: jest.fn(() => "owner"),
    useTypedRedux: jest.fn((store, field) =>
      store === "customize" && field === "collaborators_enabled"
        ? mockCollaboratorsEnabled
        : mockAccountId,
    ),
  };
});

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span>{name}</span>,
  Loading: () => <span>Loading</span>,
  Markdown: ({ value }: any) => <span>{value}</span>,
  Paragraph: ({ children }: any) => <p>{children}</p>,
  SettingBox: ({ children, title }: any) => (
    <section>
      <header>{title}</header>
      {children}
    </section>
  ),
  TimeAgo: () => <span>time</span>,
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
    conat_client: {
      hub: {
        collaborators: {
          getInvitationCounts: (...args) => getInvitationCounts(...args),
        },
      },
    },
    project_collaborators: {
      list_invites: (...args: any[]) => listInvites(...args),
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
      loaded: true,
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

describe("useInviteInboxState global pending count", () => {
  const options = { includeOutgoing: false, includeBlocks: false };
  const counts = (received: number) => ({
    pending: { received, sent: 99 },
    unread: 9000,
    revision: "1",
    coverage: "complete",
  });
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  beforeEach(() => {
    mockAccountId = "account-1";
    mockCollaboratorsEnabled = true;
    listInvites.mockReset().mockResolvedValue([]);
    getInvitationCounts.mockReset().mockResolvedValue(counts(723));
    setUnreadIncomingInviteCount(undefined, 0);
  });
  afterEach(() => {
    mockAccountId = "account-1";
    mockCollaboratorsEnabled = true;
    setUnreadIncomingInviteCount(undefined, 0);
  });

  it("uses uncapped pending.received rather than capped rows or unread collaboration notices", async () => {
    listInvites.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ invite_id: `${i}` })),
    );
    const { result } = renderHook(() => useInviteInboxState(options));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.incoming).toHaveLength(200);
    expect(listInvites).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "inbound", limit: 200 }),
    );
    expect(getInvitationCounts).toHaveBeenCalledWith({
      account_id: "account-1",
    });
    expect(getUnreadIncomingInviteCount("account-1")).toBe(723);
  });

  it("preserves the feature-off course inbox and legacy badge without calling gated counts", async () => {
    mockCollaboratorsEnabled = false;
    const invite = {
      invite_id: "course-invite",
      invite_source: "course_email",
      scope: "course_student",
    };
    listInvites.mockResolvedValue([invite]);
    getInvitationCounts.mockRejectedValue(
      Error("People invitations are unavailable"),
    );
    const { result, rerender } = renderHook(() => useInviteInboxState(options));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.incoming).toEqual([invite]);
    expect(result.current.error).toBe("");
    expect(getInvitationCounts).not.toHaveBeenCalled();
    expect(getUnreadIncomingInviteCount("account-1")).toBe(1);
    mockCollaboratorsEnabled = true;
    getInvitationCounts.mockResolvedValue(counts(723));
    rerender();
    await waitFor(() =>
      expect(getUnreadIncomingInviteCount("account-1")).toBe(723),
    );
  });

  it("loads existing invitations even when the enabled count service fails", async () => {
    const invite = {
      invite_id: "course-invite",
      invite_source: "course_email",
    };
    listInvites.mockResolvedValue([invite]);
    setUnreadIncomingInviteCount("account-1", 723);
    getInvitationCounts.mockRejectedValue(Error("count service unavailable"));
    const { result } = renderHook(() => useInviteInboxState(options));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.incoming).toEqual([invite]);
    expect(result.current.error).toContain("count service unavailable");
    expect(getUnreadIncomingInviteCount("account-1")).toBe(723);
  });

  it.each([false, true])(
    "keeps course invitations reviewable with gated counts unavailable (feature enabled=%s)",
    async (enabled) => {
      mockCollaboratorsEnabled = enabled;
      listInvites.mockResolvedValue([
        {
          invite_id: "course-invite",
          project_id: "course-project",
          project_title: "Course project",
          inviter_account_id: "teacher",
          inviter_name: "Teacher",
          invite_source: "course_email",
          scope: "course_student",
          created: new Date("2026-09-29T00:00:00Z"),
        },
      ]);
      getInvitationCounts.mockRejectedValue(Error("People count unavailable"));
      const review = jest.fn();
      function Inbox() {
        const state = useInviteInboxState(options);
        return (
          <>
            <IncomingInviteBanner state={state} onReview={review} />
            <IncomingInvitesNotificationSection state={state} />
          </>
        );
      }
      render(<Inbox />);
      fireEvent.click(await screen.findByRole("button", { name: "Review" }));
      expect(review).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
      expect(screen.getByText("Course project")).toBeInTheDocument();
      if (!enabled) expect(getInvitationCounts).not.toHaveBeenCalled();
    },
  );

  it.each(["count", "list"])(
    "keeps the previous count during refresh and after %s failure",
    async (failure) => {
      const { result } = renderHook(() => useInviteInboxState(options));
      await waitFor(() => expect(result.current.loaded).toBe(true));
      const pending = deferred<any>();
      (failure === "count"
        ? getInvitationCounts
        : listInvites
      ).mockReturnValueOnce(pending.promise);
      const seen: number[] = [];
      const unsubscribe = subscribeUnreadIncomingInviteCount((count) =>
        seen.push(count),
      );
      try {
        let refresh!: Promise<void>;
        act(() => {
          refresh = result.current.load();
        });
        expect(result.current.loading).toBe(true);
        expect(getUnreadIncomingInviteCount("account-1")).toBe(723);
        await act(async () => {
          pending.reject(Error("service unavailable"));
          await refresh;
        });
        expect(result.current.error).toContain("service unavailable");
        expect(getUnreadIncomingInviteCount("account-1")).toBe(723);
        expect(seen).toEqual([]);
      } finally {
        unsubscribe();
      }
      getInvitationCounts.mockResolvedValueOnce(counts(0));
      await act(async () => result.current.load());
      expect(result.current.error).toBe("");
      expect(getUnreadIncomingInviteCount("account-1")).toBe(0);
    },
  );

  it.each([
    undefined,
    null,
    {},
    { pending: {} },
    counts(NaN),
    counts(-1),
    counts(1.5),
  ])(
    "does not turn malformed count response %j into a fake zero",
    async (response) => {
      setUnreadIncomingInviteCount("account-1", 723);
      getInvitationCounts.mockResolvedValueOnce(response);
      const { result } = renderHook(() => useInviteInboxState(options));
      await waitFor(() =>
        expect(result.current.error).toContain(
          "Invalid pending invitation count",
        ),
      );
      expect(getUnreadIncomingInviteCount("account-1")).toBe(723);
    },
  );

  it.each([{ project_id: "project-1" }, { includeIncoming: false }])(
    "leaves global counts alone for scoped/disabled incoming loads %j",
    async (scope) => {
      setUnreadIncomingInviteCount("account-1", 723);
      const { result } = renderHook(() =>
        useInviteInboxState({ ...options, ...scope }),
      );
      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(getInvitationCounts).not.toHaveBeenCalled();
      expect(getUnreadIncomingInviteCount("account-1")).toBe(723);
    },
  );

  it("ignores stale refresh replies and late replies from a previous account", async () => {
    const stale = deferred<any>();
    getInvitationCounts.mockReturnValueOnce(stale.promise);
    const { result, rerender } = renderHook(() => useInviteInboxState(options));
    await act(async () => result.current.load());
    expect(getUnreadIncomingInviteCount("account-1")).toBe(723);
    await act(async () => {
      stale.resolve(counts(999));
      await stale.promise;
    });
    expect(getUnreadIncomingInviteCount("account-1")).toBe(723);
    const previous = deferred<any>();
    getInvitationCounts.mockReturnValueOnce(previous.promise);
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.load();
    });
    mockAccountId = "account-2";
    getInvitationCounts.mockResolvedValueOnce(counts(4));
    rerender();
    await waitFor(() =>
      expect(getUnreadIncomingInviteCount("account-2")).toBe(4),
    );
    await act(async () => {
      previous.resolve(counts(999));
      await refresh;
    });
    expect(getUnreadIncomingInviteCount("account-2")).toBe(4);
    expect(getUnreadIncomingInviteCount("account-1")).toBe(0);
    mockAccountId = undefined;
    rerender();
    expect(getUnreadIncomingInviteCount("account-2")).toBe(0);
  });
});

describe("InviteInboxPanel outgoing email delivery", () => {
  beforeEach(() => {
    listInvites.mockReset();
  });

  it("requires manual link delivery when no email was sent", async () => {
    listInvites.mockImplementation(async ({ direction }) =>
      direction === "all"
        ? [
            {
              invite_id: "invite-manual",
              project_id: "project-1",
              project_title: "Demo Project",
              inviter_account_id: "account-1",
              invite_source: "email",
              target_email: "student@example.com",
              status: "pending",
              created: new Date("2026-08-19T00:00:00.000Z"),
              last_sent: null,
            },
          ]
        : [],
    );

    const { InviteInboxPanel } = await import("./invite-inbox");
    render(
      <InviteInboxPanel project_id="project-1" mode="project" showWhenEmpty />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /pending invitations/i }),
    );
    expect(
      await screen.findByRole("status", {
        name: /invitation email delivery status/i,
      }),
    ).toHaveTextContent(/must use copy link/i);
    expect(
      screen.getByRole("button", { name: /copy link/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/invite created/i)).toBeInTheDocument();
    expect(screen.queryByText(/^sent/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /basic membership/i }),
    ).toHaveAttribute("href", expect.stringMatching(/settings\/membership/));
  });
});
