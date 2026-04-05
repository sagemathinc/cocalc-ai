jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({
      get: (field: string) =>
        field === "account_id"
          ? "11111111-1111-4111-8111-111111111111"
          : undefined,
    }),
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
import { webapp_client } from "@cocalc/frontend/webapp-client";

const query = webapp_client.query_client.query as jest.Mock;
const createMention = webapp_client.conat_client.hub.notifications
  .createMention as jest.Mock;

describe("submit_mentions", () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue(undefined);
    createMention.mockReset().mockResolvedValue(undefined);
  });

  it("dual-writes valid mentions to the legacy table and new notifications RPC", async () => {
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

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith({
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
    expect(createMention).toHaveBeenCalledTimes(1);
    expect(createMention).toHaveBeenCalledWith({
      source_project_id: "22222222-2222-4222-8222-222222222222",
      source_path: "foo.txt",
      source_fragment_id: "chat=true,id=abc123",
      target_account_ids: ["33333333-3333-4333-8333-333333333333"],
      description: "ping",
      stable_source_id: "chat=true,id=abc123",
    });
  });
});
