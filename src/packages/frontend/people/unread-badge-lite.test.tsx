/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";

const mockList = jest.fn();

// CoCalc Lite: there is no People API on its hub.
jest.mock("@cocalc/frontend/lite", () => ({ lite: true }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => undefined,
    reduxStore: { subscribe: () => () => {} },
  },
  useTypedRedux: (_store: string, field: string) =>
    field === "account_id" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : undefined,
}));
jest.mock("./api", () => {
  const { EventEmitter } = require("events");
  return {
    peopleApi: () => ({ listConversations: mockList }),
    conversationEvents: new EventEmitter(),
  };
});

import { resetConversationsForTests } from "./use-conversations";
import { PeopleUnreadBadge } from "./unread-badge";

beforeEach(() => {
  jest.useFakeTimers();
  resetConversationsForTests();
  mockList.mockReset();
  mockList.mockResolvedValue({ conversations: [], unavailable_bays: [] });
});

afterEach(() => {
  jest.useRealTimers();
});

test("in Lite the People badge never asks for conversations, now or later", async () => {
  const { container } = render(<PeopleUnreadBadge />);
  await act(async () => {
    jest.advanceTimersByTime(5 * 60_000);
  });
  expect(mockList).not.toHaveBeenCalled();
  expect(container.textContent).toBe("");
});
