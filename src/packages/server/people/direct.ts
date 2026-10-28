/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Direct conversations: routing, consent and delivery. The record and
// messages live on the owning bay (the creator's home bay when started); each
// member's home bay keeps an index row, updated by fan-out from the owning
// bay, and decides whether to notify its member. See
// @cocalc/util/direct-conversations.

import { requireUuid } from "@cocalc/conat/agents/protocol";
import {
  createInterBayDirectClient,
  type InterBayDirectApi,
} from "@cocalc/conat/inter-bay/direct";
import {
  addDirectMessage,
  areCollaborators,
  assertDirectRequestQuota,
  blockDirectSender,
  clearDirectFanout,
  createDirectConversationRecord,
  dueDirectFanouts,
  findDirectPair,
  getDirectConversationRecord,
  getDirectIndex,
  isDirectBlocked,
  listDirectIndex,
  listDirectMessages,
  markDirectRead,
  recordDirectFanoutFailure,
  setDirectMemberState,
  setDirectMuted,
  upsertDirectIndex,
} from "@cocalc/database/postgres/direct-conversations";
import {
  createNotificationEventGraph,
  resolveNotificationTargetHomeBays,
} from "@cocalc/database/postgres/notifications-core";
import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getClusterAccountsByIds } from "@cocalc/server/inter-bay/accounts";
import {
  ensureAccountSecurityStateReady,
  isAccountBannedCached,
} from "@cocalc/server/accounts/security-state";
import { resolveUsernameOwner } from "@cocalc/server/accounts/usernames";
import {
  directPreview,
  directRoute,
  normalizeDirectBody,
  normalizeDirectMembers,
  normalizeDirectTitle,
  type DirectConversation,
  type DirectMemberState,
  type DirectMessage,
  type DirectResponse,
  type ListedDirectConversation,
} from "@cocalc/util/direct-conversations";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";

const logger = getLogger("server:people:direct");
const FANOUT_RETRY_MS = 30_000;
// A generic answer, so senders can't learn whom they're blocked by.
const CANNOT_MESSAGE = "you can't message this person";

function bay(): string {
  return getConfiguredBayId();
}

function remote(bay_id: string): InterBayDirectApi {
  return createInterBayDirectClient({
    client: getInterBayFabricClient(),
    bay_id,
  });
}

async function homeBay(account_id: string): Promise<string> {
  requireUuid(account_id, "account_id");
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id) throw Error("account home unavailable");
  return home_bay_id;
}

async function home(account_id: string): Promise<InterBayDirectApi> {
  const bay_id = await homeBay(account_id);
  return bay_id === bay() ? directControl : remote(bay_id);
}

function owner(owner_bay_id: string): InterBayDirectApi {
  return owner_bay_id === bay() ? directControl : remote(owner_bay_id);
}

async function assertHome(account_id: string): Promise<void> {
  if ((await homeBay(account_id)) !== bay()) {
    throw Error("stale account-home route");
  }
}

async function assertCanSend(account_id: string): Promise<void> {
  await ensureAccountSecurityStateReady();
  if (isAccountBannedCached(account_id)) throw Error(CANNOT_MESSAGE);
}

// The conversation, if this bay owns it and the account is in it and may
// still see it.
async function memberRecord(
  account_id: string,
  conversation_id: string,
): Promise<{ conversation: DirectConversation; state: DirectMemberState }> {
  requireUuid(conversation_id, "conversation_id");
  const conversation = await getDirectConversationRecord(
    conversation_id,
    bay(),
  );
  if (conversation == null || !conversation.member_ids.includes(account_id)) {
    throw Error("conversation not found");
  }
  const state = conversation.member_states[account_id] ?? "active";
  if (state === "declined" || state === "blocked") {
    throw Error("conversation not found");
  }
  return { conversation, state };
}

// Tell every member's home bay; what can't be delivered now is retried.
async function fanout(
  conversation: DirectConversation,
  message?: Pick<DirectMessage, "message_id" | "sender_id" | "body">,
): Promise<void> {
  await Promise.all(
    conversation.member_ids.map(async (account_id) => {
      try {
        await (
          await home(account_id)
        ).upsertIndex({ account_id, conversation, message: message ?? null });
      } catch (err) {
        logger.warn("direct conversation fan-out failed; will retry", {
          conversation_id: conversation.conversation_id,
          account_id,
          err: `${err}`,
        });
        await recordDirectFanoutFailure({
          conversation_id: conversation.conversation_id,
          account_id,
          error: `${err}`,
        }).catch(() => {});
      }
    }),
  );
}

let retryTimer: ReturnType<typeof setInterval> | undefined;
export function startDirectFanoutRetries(): void {
  if (retryTimer != null) return;
  retryTimer = setInterval(() => {
    void retryDirectFanouts().catch((err) =>
      logger.warn("direct fan-out retry failed", { err: `${err}` }),
    );
  }, FANOUT_RETRY_MS);
  retryTimer.unref?.();
}

export async function retryDirectFanouts(): Promise<void> {
  for (const { conversation_id, account_id } of await dueDirectFanouts()) {
    const conversation = await getDirectConversationRecord(
      conversation_id,
      bay(),
    );
    if (conversation == null) {
      await clearDirectFanout(conversation_id, account_id);
      continue;
    }
    try {
      // The latest state; missed messages are not notified late.
      await (await home(account_id)).upsertIndex({ account_id, conversation });
      await clearDirectFanout(conversation_id, account_id);
    } catch (err) {
      await recordDirectFanoutFailure({
        conversation_id,
        account_id,
        error: `${err}`,
      });
    }
  }
}

async function names(account_ids: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    for (const entry of await getClusterAccountsByIds(account_ids)) {
      result.set(
        entry.account_id,
        displayNameFromAccount(entry as any) || "Someone",
      );
    }
  } catch (err) {
    logger.debug("names unavailable", { err: `${err}` });
  }
  return result;
}

// On the member's home bay: a new message reached them.
async function notify({
  account_id,
  previous,
  current,
  message,
}: {
  account_id: string;
  previous: ListedDirectConversation | null;
  current: ListedDirectConversation;
  message: Pick<DirectMessage, "message_id" | "sender_id" | "body">;
}): Promise<void> {
  if (message.sender_id === account_id || current.muted) return;
  // A request notifies once, when it arrives; nothing more until accepted.
  const request = current.state === "requested";
  if (request && previous != null) return;
  if (current.state !== "active" && !request) return;
  const sender =
    (await names([message.sender_id])).get(message.sender_id) ?? "Someone";
  const summary = {
    title: request
      ? `${sender} sent you a message request`
      : `Message from ${sender}`,
    body_markdown: directPreview(message.body),
    severity: "info",
    origin_label: "Messages",
    notice_type: "direct_message",
    action_label: request ? "Review request" : "Open conversation",
    action_link: `/people/${directRoute(current.conversation_id)}`,
    conversation_id: current.conversation_id,
  };
  const homes = await resolveNotificationTargetHomeBays({
    account_ids: [account_id],
    default_bay_id: bay(),
  });
  await createNotificationEventGraph({
    kind: "account_notice",
    source_bay_id: bay(),
    source_project_id: null,
    actor_account_id: message.sender_id,
    origin_kind: "system",
    payload_json: summary,
    targets: [
      {
        target_account_id: account_id,
        target_home_bay_id: homes[account_id],
        dedupe_key: `direct-message:${message.message_id}:${account_id}`,
        summary_json: summary,
      },
    ],
  });
}

export const directControl: InterBayDirectApi = {
  // ---- owner ----
  async messages({ account_id, conversation_id, before }) {
    const { conversation } = await memberRecord(account_id, conversation_id);
    const messages = await listDirectMessages({ conversation_id, before });
    return { conversation, messages: messages.reverse() };
  },

  async send({ account_id, conversation_id, body }) {
    await assertCanSend(account_id);
    body = normalizeDirectBody(body);
    const { state } = await memberRecord(account_id, conversation_id);
    // Replying to a request accepts it.
    if (state === "requested") {
      await setDirectMemberState({
        conversation_id,
        account_id,
        state: "active",
        owner_bay_id: bay(),
      });
    }
    const { message, conversation } = await addDirectMessage({
      conversation_id,
      sender_id: account_id,
      body,
      owner_bay_id: bay(),
    });
    await fanout(conversation, message);
    return message;
  },

  async respond({ account_id, conversation_id, action }) {
    const { conversation: before } = await memberRecord(
      account_id,
      conversation_id,
    );
    const state: DirectMemberState =
      action === "accept"
        ? "active"
        : action === "decline"
          ? "declined"
          : action === "block"
            ? "blocked"
            : (() => {
                throw Error(`invalid action: ${action}`);
              })();
    if (action === "block" && before.created_by !== account_id) {
      // Blocks live on the blocker's home bay.
      await (
        await home(account_id)
      ).block({ account_id, blocked_account_id: before.created_by });
    }
    const conversation = await setDirectMemberState({
      conversation_id,
      account_id,
      state,
      owner_bay_id: bay(),
    });
    if (conversation == null) throw Error("conversation not found");
    await fanout(conversation);
    return conversation;
  },

  // ---- home ----
  async start({ account_id, member_ids, title, body }) {
    await assertHome(account_id);
    await assertCanSend(account_id);
    const members = normalizeDirectMembers(account_id, member_ids);
    const normalizedTitle = normalizeDirectTitle(title);
    const text = body == null || `${body}`.trim() === "" ? null : body;
    // One conversation per pair (untitled): reuse it.
    if (members.length === 2 && normalizedTitle == null) {
      const existing = await findDirectPair(account_id, members[1]);
      if (
        existing != null &&
        (existing.state === "active" || existing.state === "requested")
      ) {
        if (text != null) {
          await owner(existing.owner_bay_id).send({
            account_id,
            conversation_id: existing.conversation_id,
            body: text,
          });
        }
        return (await getDirectIndex(account_id, existing.conversation_id))!;
      }
    }
    const states: Record<string, DirectMemberState> = {
      [account_id]: "active",
    };
    for (const other of members.slice(1)) {
      if (
        await (
          await home(other)
        ).isBlocked({ account_id: other, sender_id: account_id })
      ) {
        throw Error(CANNOT_MESSAGE);
      }
      states[other] = (await areCollaborators(account_id, other))
        ? "active"
        : "requested";
    }
    if (Object.values(states).includes("requested")) {
      await assertDirectRequestQuota(account_id);
    }
    let conversation = await createDirectConversationRecord({
      owner_bay_id: bay(),
      created_by: account_id,
      member_ids: members,
      member_states: states,
      title: normalizedTitle,
    });
    let message: DirectMessage | undefined;
    if (text != null) {
      ({ message, conversation } = await addDirectMessage({
        conversation_id: conversation.conversation_id,
        sender_id: account_id,
        body: normalizeDirectBody(text),
        owner_bay_id: bay(),
      }));
    }
    await fanout(conversation, message);
    const listed = await getDirectIndex(
      account_id,
      conversation.conversation_id,
    );
    if (listed == null) throw Error("conversation was not recorded");
    return listed;
  },

  async list({ account_id }) {
    await assertHome(account_id);
    return await listDirectIndex(account_id);
  },

  async getIndex({ account_id, conversation_id }) {
    await assertHome(account_id);
    requireUuid(conversation_id, "conversation_id");
    return await getDirectIndex(account_id, conversation_id);
  },

  async upsertIndex({ account_id, conversation, message }) {
    await assertHome(account_id);
    if (!conversation.member_ids.includes(account_id)) {
      throw Error("not a member");
    }
    const { previous, current } = await upsertDirectIndex({
      account_id,
      conversation,
    });
    if (message != null) {
      try {
        await notify({ account_id, previous, current, message });
      } catch (err) {
        logger.warn("direct message notification failed", {
          account_id,
          conversation_id: conversation.conversation_id,
          err: `${err}`,
        });
      }
    }
  },

  async isBlocked({ account_id, sender_id }) {
    await assertHome(account_id);
    return await isDirectBlocked(account_id, sender_id);
  },

  async block({ account_id, blocked_account_id }) {
    await assertHome(account_id);
    requireUuid(blocked_account_id, "blocked_account_id");
    await blockDirectSender(account_id, blocked_account_id);
  },

  async markRead({ account_id, conversation_id, read_through }) {
    await assertHome(account_id);
    await markDirectRead({ account_id, conversation_id, read_through });
  },

  async setMuted({ account_id, conversation_id, muted }) {
    await assertHome(account_id);
    await setDirectMuted({ account_id, conversation_id, muted: !!muted });
  },
};

// What the hub exposes to signed-in accounts (account_id is the caller).
async function listedOrThrow(
  account_id: string,
  conversation_id: string,
): Promise<ListedDirectConversation> {
  const listed = await (
    await home(account_id)
  ).getIndex({ account_id, conversation_id });
  if (listed == null) throw Error("conversation not found");
  return listed;
}

export const directHubApi = {
  async listDirect({ account_id }: { account_id?: string }) {
    return {
      conversations: await (
        await home(account_id!)
      ).list({ account_id: account_id! }),
    };
  },

  async startDirect({
    account_id,
    member_ids,
    title,
    body,
  }: {
    account_id?: string;
    member_ids: string[];
    title?: string | null;
    body?: string | null;
  }) {
    return await (
      await home(account_id!)
    ).start({ account_id: account_id!, member_ids, title, body });
  },

  // A page of messages, oldest first, and the conversation as listed for the
  // caller (its read state and mute come from their home bay).
  async getDirect({
    account_id,
    conversation_id,
    before,
  }: {
    account_id?: string;
    conversation_id: string;
    before?: number | null;
  }) {
    const listed = await listedOrThrow(account_id!, conversation_id);
    const { conversation, messages } = await owner(
      listed.owner_bay_id,
    ).messages({ account_id: account_id!, conversation_id, before });
    return {
      conversation: {
        ...listed,
        ...conversation,
        state: conversation.member_states[account_id!] ?? listed.state,
      } as ListedDirectConversation,
      messages,
    };
  },

  async sendDirect({
    account_id,
    conversation_id,
    body,
  }: {
    account_id?: string;
    conversation_id: string;
    body: string;
  }) {
    const listed = await listedOrThrow(account_id!, conversation_id);
    return await owner(listed.owner_bay_id).send({
      account_id: account_id!,
      conversation_id,
      body,
    });
  },

  async respondDirect({
    account_id,
    conversation_id,
    action,
  }: {
    account_id?: string;
    conversation_id: string;
    action: DirectResponse;
  }) {
    const listed = await listedOrThrow(account_id!, conversation_id);
    return await owner(listed.owner_bay_id).respond({
      account_id: account_id!,
      conversation_id,
      action,
    });
  },

  async markDirectRead({
    account_id,
    conversation_id,
    read_through,
  }: {
    account_id?: string;
    conversation_id: string;
    read_through: number;
  }) {
    await (
      await home(account_id!)
    ).markRead({ account_id: account_id!, conversation_id, read_through });
  },

  async setDirectMuted({
    account_id,
    conversation_id,
    muted,
  }: {
    account_id?: string;
    conversation_id: string;
    muted: boolean;
  }) {
    await (
      await home(account_id!)
    ).setMuted({ account_id: account_id!, conversation_id, muted });
  },

  // Someone to message by their exact username (usernames are public, in
  // personal URLs); email addresses are not looked up.
  async findDirectRecipient({
    username,
  }: {
    account_id?: string;
    username: string;
  }): Promise<{ account_id: string; name: string } | null> {
    const value = `${username ?? ""}`.trim().replace(/^@/, "");
    if (!value) return null;
    try {
      const owner = await resolveUsernameOwner(value);
      if (!owner?.account_id) return null;
      const name =
        (await names([owner.account_id])).get(owner.account_id) ?? value;
      return { account_id: owner.account_id, name };
    } catch {
      return null;
    }
  },
};
