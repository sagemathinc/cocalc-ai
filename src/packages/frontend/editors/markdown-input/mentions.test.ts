import { fromJS } from "immutable";

const mockGetStore = jest.fn();

jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: () => null,
}));

jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (name: string) => mockGetStore(name),
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    query_client: { query: jest.fn() },
    conat_client: {
      hub: {
        notifications: {
          createMention: jest.fn(),
        },
      },
    },
  },
}));

import { submit_mentions } from "./mentions";
import { ALL_PROJECT_COLLABORATORS_MENTION_ID } from "./mention-all";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const query = webapp_client.query_client.query as jest.Mock;
const createMention = webapp_client.conat_client.hub.notifications
  .createMention as jest.Mock;

describe("submit_mentions", () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue(undefined);
    createMention.mockReset().mockResolvedValue(undefined);
    mockGetStore.mockReset();
    mockGetStore.mockImplementation((name: string) => {
      if (name === "account") {
        return fromJS({
          account_id: "11111111-1111-4111-8111-111111111111",
        });
      }
      if (name === "projects") {
        return fromJS({
          project_map: {
            "22222222-2222-4222-8222-222222222222": {
              users: {
                "11111111-1111-4111-8111-111111111111": {
                  group: "owner",
                },
                "33333333-3333-4333-8333-333333333333": {
                  group: "collaborator",
                },
                "44444444-4444-4444-8444-444444444444": {
                  group: "collaborator",
                },
                "55555555-5555-4555-8555-555555555555": {
                  group: "viewer",
                },
              },
            },
          },
        });
      }
      throw new Error(`unexpected store ${name}`);
    });
  });

  it("dual-writes valid mentions to the legacy table and batches the notifications RPC", async () => {
    await submit_mentions(
      "22222222-2222-4222-8222-222222222222",
      ".foo.txt.sage-chat",
      [
        {
          account_id: "33333333-3333-4333-8333-333333333333",
          description: "ping",
          fragment_id: "chat=true,id=abc123",
        },
        {
          account_id: "44444444-4444-4444-8444-444444444444",
          description: "ping",
          fragment_id: "chat=true,id=abc123",
        },
        {
          account_id: "not-a-uuid",
          description: "ignored",
        },
        {
          account_id: "33333333-3333-4333-8333-333333333333",
          description: "duplicate fragment",
          fragment_id: "chat=true,id=abc123",
        },
      ],
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, {
      query: {
        mentions: {
          project_id: "22222222-2222-4222-8222-222222222222",
          path: "foo.txt",
          fragment_id: "chat=true,id=abc123",
          target: "33333333-3333-4333-8333-333333333333",
          priority: 2,
          description: "ping",
          source: "11111111-1111-4111-8111-111111111111",
        },
      },
    });
    expect(query).toHaveBeenNthCalledWith(2, {
      query: {
        mentions: {
          project_id: "22222222-2222-4222-8222-222222222222",
          path: "foo.txt",
          fragment_id: "chat=true,id=abc123",
          target: "44444444-4444-4444-8444-444444444444",
          priority: 2,
          description: "ping",
          source: "11111111-1111-4111-8111-111111111111",
        },
      },
    });
    expect(createMention).toHaveBeenCalledTimes(1);
    expect(createMention).toHaveBeenCalledWith({
      source_project_id: "22222222-2222-4222-8222-222222222222",
      source_path: "foo.txt",
      source_fragment_id: "chat=true,id=abc123",
      target_account_ids: [
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ],
      description: "ping",
      stable_source_id: "chat=true,id=abc123",
    });
  });

  it("expands @all to other owner/collaborator project users", async () => {
    await submit_mentions("22222222-2222-4222-8222-222222222222", "room.chat", [
      {
        account_id: ALL_PROJECT_COLLABORATORS_MENTION_ID,
        description: "@all please read this",
        fragment_id: "chat=true,id=all123",
      },
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([arg]) => arg.query.mentions.target)).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ]);
    expect(createMention).toHaveBeenCalledTimes(1);
    expect(createMention).toHaveBeenCalledWith({
      source_project_id: "22222222-2222-4222-8222-222222222222",
      source_path: "room.chat",
      source_fragment_id: "chat=true,id=all123",
      target_account_ids: [
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ],
      description: "@all please read this",
      stable_source_id: "chat=true,id=all123",
    });
  });
});
