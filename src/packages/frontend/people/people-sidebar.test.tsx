/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PeopleSidebar, sidebarConversations } from "./people-sidebar";

const me = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const pageState = jest.fn();
const setActiveTab = jest.fn();
const setState = jest.fn(async () => {});
const setOrder = jest.fn();
const conv = (id: string, title: string, extra = {}) => ({
  conversation_id: id,
  project_id: "p",
  path: `/home/user/${id}.chat`,
  title,
  created_by: me,
  created: 1,
  last_activity: 1,
  last_sender_id: null,
  participant_ids: [],
  ...extra,
});
const mockConversations = [
  conv("c1", "Weekly", { pinned: true, last_activity: 5 }),
  conv("c2", "Design", { last_activity: 9, last_sender_id: "someone" }),
  conv("c3", "Budget", { pinned: true, last_activity: 2 }),
  conv("c4", "Old", { last_activity: 1 }),
];

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({ setState: pageState, set_active_tab: setActiveTab }),
  },
  useTypedRedux: (_store: string, field: string) =>
    field === "account_id"
      ? me
      : field === "people_route"
        ? "conversations/p/c2"
        : undefined,
}));
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
jest.mock("./use-conversations", () => ({
  useConversations: () => ({
    conversations: mockConversations,
    loading: false,
  }),
}));
jest.mock("./conversation-collection", () => ({
  setConversationState: (...a) => setState(...a),
}));
jest.mock("@cocalc/frontend/components/use-collection-preferences", () => ({
  useCollectionPreferences: () => ({
    value: { view: "list", order: ["c3"] },
    setOrder: (...a) => setOrder(...a),
  }),
}));

beforeEach(() => jest.clearAllMocks());

test("pins in saved order (newly pinned last), the rest by activity", () => {
  const { pinned, recent } = sidebarConversations(
    mockConversations as any,
    ["c3"],
    () => true,
    2,
  );
  expect(pinned.map((c) => c.title)).toEqual(["Budget", "Weekly"]);
  expect(recent.map((c) => c.title)).toEqual(["Design", "Old"]);
});

it("opens conversations, marks the current one and unread ones, pins", async () => {
  const user = userEvent.setup();
  render(<PeopleSidebar search="" />);
  const pinned = screen.getByRole("list", { name: "Pinned people" });
  expect(
    within(pinned).getAllByRole("button", { name: /^Open conversation/ })
      .length,
  ).toBe(2);
  const design = screen.getByRole("button", {
    name: "Open conversation Design",
  });
  expect(design).toHaveAttribute("aria-current", "page");
  expect(within(design).getByLabelText("Unread")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Open conversation Old" }),
  );
  expect(pageState).toHaveBeenCalledWith({
    people_route: "conversations/p/c4",
  });
  expect(setActiveTab).toHaveBeenCalledWith("people", true);
  await user.click(screen.getByRole("button", { name: "Pin Old" }));
  expect(setOrder).toHaveBeenCalledWith(["c3", "c1", "c4"]);
  expect(setState).toHaveBeenCalledWith(
    expect.objectContaining({ conversation_id: "c4" }),
    { pinned: true },
  );
});

it("New Conversation asks People to open its dialog", async () => {
  const { newConversationRequest } = jest.requireActual(
    "@cocalc/frontend/app/sidebar-search-requests",
  );
  const opened = jest.fn();
  const stop = newConversationRequest.on(opened);
  render(<PeopleSidebar search="" />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "New Conversation" }));
  expect(opened).toHaveBeenCalledTimes(1);
  stop();
});
