/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const projectId = "22222222-2222-4222-8222-222222222222";
const sender = "11111111-1111-4111-8111-111111111111";
const alice = "33333333-3333-4333-8333-333333333333";
const bob = "44444444-4444-4444-8444-444444444444";
const carol = "55555555-5555-4555-8555-555555555555";

jest.mock("@cocalc/frontend/editors/markdown-input/mention-all", () => ({
  ALL_PROJECT_COLLABORATORS_MENTION_ID: "__all__",
  getMentionAllAccountIds: () => [sender, alice, bob],
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        notifications: {
          createMention: jest.fn(),
        },
      },
    },
  },
}));

import {
  buildThreadNotificationPlan,
  extractMentionAccountIds,
  sendThreadFollowerNotifications,
} from "../thread-notifications";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { serializeCollaborationReference } from "@cocalc/util/collaboration-references";

describe("thread notification planning", () => {
  it("notifies previous thread participants unless muted or directly mentioned", () => {
    const plan = buildThreadNotificationPlan({
      project_id: projectId,
      sender_id: sender,
      input: `<span class="user-mention" account-id=${bob} >@Bob</span> please check`,
      threadMessages: [
        {
          event: "chat",
          sender_id: alice,
          history: [],
          date: "2026-07-10T00:00:00.000Z",
        },
        {
          event: "chat",
          sender_id: carol,
          history: [],
          date: "2026-07-10T00:00:01.000Z",
        },
      ],
      notificationState: {
        notification_followers: [bob],
        notification_muted: [carol],
      },
    });

    expect(plan.explicitMentionTargets).toEqual([bob]);
    expect(plan.followerTargets).toEqual([alice]);
    expect(plan.nextFollowers).toEqual([sender, alice, bob, carol].sort());
    expect(plan.nextMuted).toEqual([carol]);
  });

  it("expands @all to collaborator account ids", () => {
    expect(
      extractMentionAccountIds({
        project_id: projectId,
        input: '<span class="user-mention" account-id=__all__ >@all</span>',
      }).sort(),
    ).toEqual([sender, alice, bob].sort());
  });

  it("submits followed-thread notifications through the mention RPC", async () => {
    const reference = serializeCollaborationReference({
      version: 1,
      target: {
        project_id: projectId,
        kind: "artifact",
        resource_id: "artifact:picture",
      },
      display_fallback: "Picture Lake",
    });
    const createMention = jest.mocked(
      webapp_client.conat_client.hub.notifications.createMention,
    );
    createMention.mockResolvedValue({
      event_id: "77777777-7777-4777-8777-777777777777",
      kind: "mention",
      notification_ids: ["66666666-6666-4666-8666-666666666666"],
      source_bay_id: "bay-0",
      target_count: 1,
      targets: [
        {
          notification_id: "66666666-6666-4666-8666-666666666666",
          target_account_id: alice,
          target_home_bay_id: "bay-0",
        },
      ],
    });

    await expect(
      sendThreadFollowerNotifications({
        project_id: projectId,
        path: "/home/user/room.chat",
        thread_id: "thread-1",
        message_id: "message-1",
        date: "2026-07-10T00:00:00.000Z",
        input: `See ${reference}`,
        target_account_ids: [alice],
      }),
    ).resolves.toEqual({ notified_account_ids: [alice] });

    expect(createMention).toHaveBeenCalledWith(
      expect.objectContaining({
        source_project_id: projectId,
        source_path: "/home/user/room.chat",
        target_account_ids: [alice],
        stable_source_id: "message-1:thread-follow",
        notification_reason: "thread_follow",
        description: `New reply in a chat thread you follow:\n\nSee ${reference}`,
      }),
    );
  });
});
