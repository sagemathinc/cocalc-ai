/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import Composing from "../composing";

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: ({ account_id }: any) => (
    <span data-testid="avatar">{account_id}</span>
  ),
}));

jest.mock("@cocalc/frontend/components/progress-estimate", () => ({
  __esModule: true,
  default: () => <span data-testid="progress-estimate" />,
}));

function makeUserMap(name: string) {
  return new Map([
    [
      "remote-account",
      {
        get: (key: string, fallback = "") =>
          key === "first_name" ? name : fallback,
      },
    ],
  ]);
}

function makeSyncdb(threadKey: string) {
  return {
    isReady: () => true,
    on: jest.fn(),
    removeListener: jest.fn(),
    get_cursors: jest.fn(
      () =>
        new Map([
          [
            "remote-account",
            {
              locs: [
                {
                  chat_composing: true,
                  chat_thread_key: threadKey,
                },
              ],
            },
          ],
        ]),
    ),
  };
}

describe("Composing", () => {
  it("uses current thread metadata for typing indicator titles", () => {
    const actions = {
      syncdb: makeSyncdb("thread-id-1"),
      getThreadIndex: jest.fn(
        () =>
          new Map([
            [
              "thread-id-1",
              {
                key: "thread-id-1",
                newestTime: 1,
                messageCount: 1,
                messageKeys: new Set(["root-date-key"]),
                rootMessage: {
                  event: "chat",
                  sender_id: "remote-account",
                  date: "2026-05-29T00:00:00.000Z",
                  thread_id: "thread-id-1",
                  history: [
                    {
                      author_id: "remote-account",
                      content: "Old root message title",
                      date: "2026-05-29T00:00:00.000Z",
                    },
                  ],
                },
              },
            ],
          ]),
      ),
      getThreadMetadata: jest.fn(() => ({ name: "Current Thread Title" })),
      listThreadConfigRows: jest.fn(() => []),
    } as any;

    render(
      <Composing
        actions={actions}
        projectId="project-1"
        path="chat.chat"
        accountId="local-account"
        userMap={makeUserMap("Ada")}
      />,
    );

    expect(
      screen.getByText('Ada is writing a message in "Current Thread Title"...'),
    ).toBeInTheDocument();
  });

  it("resolves cursor thread ids from config rows when index labels are stale", () => {
    const actions = {
      syncdb: makeSyncdb("thread-id-2"),
      getThreadIndex: jest.fn(
        () =>
          new Map([
            [
              "root-date-key",
              {
                key: "root-date-key",
                newestTime: 1,
                messageCount: 1,
                messageKeys: new Set(["root-date-key"]),
                rootMessage: {
                  event: "chat",
                  sender_id: "remote-account",
                  date: "2026-05-29T00:00:00.000Z",
                  thread_id: "thread-id-2",
                  history: [
                    {
                      author_id: "remote-account",
                      content: "Wrong fallback title",
                      date: "2026-05-29T00:00:00.000Z",
                    },
                  ],
                },
              },
            ],
          ]),
      ),
      getThreadMetadata: jest.fn(() => ({})),
      listThreadConfigRows: jest.fn(() => [
        {
          event: "chat-thread-config",
          thread_id: "thread-id-2",
          name: "Renamed Thread",
        },
      ]),
    } as any;

    render(
      <Composing
        actions={actions}
        projectId="project-1"
        path="chat.chat"
        accountId="local-account"
        userMap={makeUserMap("Ada")}
      />,
    );

    expect(
      screen.getByText('Ada is writing a message in "Renamed Thread"...'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Wrong fallback title/)).toBeNull();
  });
});
