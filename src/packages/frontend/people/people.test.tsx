/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ListedConversation } from "@cocalc/util/people";
import { ConversationCollection } from "./conversation-collection";
import {
  isMentioned,
  isUnread,
  matchesPerson,
  matchesScope,
  matchesSearch,
} from "./scope";

const me = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mockSetState = jest.fn(async () => ({}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string, field: string) =>
    store === "account" && field === "account_id" ? me : undefined,
}));
jest.mock("@cocalc/frontend/account/avatar/avatar-stack", () => ({
  AvatarStack: () => null,
}));
jest.mock("@cocalc/frontend/components", () => ({
  TimeAgo: () => null,
}));
jest.mock("./api", () => ({
  peopleApi: () => ({ setState: mockSetState, markRead: jest.fn() }),
  conversationsChanged: jest.fn(),
}));

function conversation(
  conversation_id: string,
  title: string,
  extra: Partial<ListedConversation> = {},
): ListedConversation {
  return {
    conversation_id,
    title,
    project_id: "11111111-1111-4111-8111-111111111111",
    path: `/home/user/${conversation_id}.chat`,
    created_by: other,
    created: 1000,
    last_activity: 3000,
    last_sender_id: other,
    participant_ids: [other],
    pinned: false,
    alias: null,
    following: false,
    muted: false,
    last_read: 3000,
    mentioned_at: null,
    ...extra,
  };
}

describe("scope rules", () => {
  it("For you means participation, following or an unread mention, never muted", () => {
    expect(matchesScope(conversation("a", "A"), "for-you", me)).toBe(false);
    expect(
      matchesScope(
        conversation("a", "A", { participant_ids: [other, me] }),
        "for-you",
        me,
      ),
    ).toBe(true);
    expect(
      matchesScope(conversation("a", "A", { following: true }), "for-you", me),
    ).toBe(true);
    const mentioned = conversation("a", "A", { mentioned_at: 4000 });
    expect(isMentioned(mentioned)).toBe(true);
    expect(matchesScope(mentioned, "for-you", me)).toBe(true);
    // a mention already read through is not "for you" by itself
    expect(matchesScope({ ...mentioned, last_read: 5000 }, "for-you", me)).toBe(
      false,
    );
    expect(
      matchesScope(
        { ...mentioned, following: true, muted: true },
        "for-you",
        me,
      ),
    ).toBe(false);
    expect(
      matchesScope(conversation("a", "A", { pinned: true }), "collection", me),
    ).toBe(true);
  });

  it("unread ignores my own messages and muted conversations", () => {
    expect(isUnread(conversation("a", "A", { last_read: 1000 }), me)).toBe(
      true,
    );
    expect(
      isUnread(
        conversation("a", "A", { last_read: 1000, last_sender_id: me }),
        me,
      ),
    ).toBe(false);
    expect(
      isUnread(conversation("a", "A", { last_read: 1000, muted: true }), me),
    ).toBe(false);
  });

  it("search matches title, @alias or project", () => {
    const c = conversation("a", "Team planning", { alias: "team" });
    expect(matchesSearch(c, "plan")).toBe(true);
    expect(matchesSearch(c, "@team")).toBe(true);
    expect(matchesSearch(c, "lab", "Lab project")).toBe(true);
    expect(matchesSearch(c, "zzz")).toBe(false);
  });
});

describe("ConversationCollection", () => {
  const items = [
    conversation("p", "Pinned one", { pinned: true, alias: "pin" }),
    conversation("r", "Recent unread", { last_read: 1000, mentioned_at: 2000 }),
  ];

  it("groups pins, shows alias, unread and mention by accessible name", () => {
    render(
      <ConversationCollection
        conversations={items}
        view="list"
        onSelect={jest.fn()}
      />,
    );
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(
      within(pinned).getByRole("button", { name: /Pinned one\s*@pin/ }),
    ).toBeInTheDocument();
    const recent = screen.getByRole("region", { name: "Recent" });
    expect(
      within(recent).getByRole("button", {
        name: /Recent unread.*\(unread\).*you were mentioned/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Unpin Pinned one" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("opens with the keyboard and pins through the people API", async () => {
    const onSelect = jest.fn();
    const user = userEvent.setup();
    render(
      <ConversationCollection
        conversations={items}
        view="grid"
        selected="p"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole("button", { current: true })).toHaveAccessibleName(
      /Pinned one/,
    );
    const open = screen.getByRole("button", { name: /^Recent unread/ });
    open.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(items[1]);
    await user.click(screen.getByRole("button", { name: "Pin Recent unread" }));
    expect(mockSetState).toHaveBeenCalledWith({
      kind: "conversation",
      target_id: "r",
      project_id: items[1].project_id,
      patch: { pinned: true },
    });
  });

  it("compact rows beside an open conversation keep title and controls", () => {
    render(
      <ConversationCollection
        conversations={items}
        view="list"
        compact
        selected="r"
        onSelect={jest.fn()}
      />,
    );
    expect(screen.getByRole("button", { current: true })).toHaveAccessibleName(
      /Recent unread/,
    );
    expect(
      screen.getByRole("button", { name: /Pinned one\s*@pin/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Pin Recent unread" }),
    ).toBeInTheDocument();
  });

  it("shows the empty text", () => {
    render(
      <ConversationCollection
        conversations={[]}
        view="list"
        onSelect={jest.fn()}
        emptyText="None"
      />,
    );
    expect(screen.getByText("None")).toBeInTheDocument();
  });
});

describe("collaborator search", () => {
  it("matches name or private alias, with or without @", () => {
    const bella = {
      account_id: other,
      name: "Bella Boo",
      alias: "bb",
      pinned: false,
      sharedProjects: 3,
    };
    expect(matchesPerson(bella, "boo")).toBe(true);
    expect(matchesPerson(bella, "@bb")).toBe(true);
    expect(matchesPerson(bella, "zz")).toBe(false);
  });
});
