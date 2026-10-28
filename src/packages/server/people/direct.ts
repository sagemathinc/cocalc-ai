/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Direct conversations: routing, consent and delivery (see
// @cocalc/util/direct-conversations).
//
// - The record and messages live on the owning bay: the starter's home bay
//   for a group, and for a two-person conversation always the home bay of
//   the smaller account id, where a unique pair key makes it the only one.
// - Every change bumps the record's revision and, in the same transaction,
//   queues delivery to each member's home bay (an outbox), cleared once
//   delivered and retried until then.
// - Each member's home bay keeps an index row, applies only newer revisions,
//   and decides (and records, so retries are safe) whether to notify.
// - Consent: collaborators are active at once; anyone else, named only by
//   exact username, gets a message request: one message and one
//   notification until they accept. Requests are charged against the
//   starter's daily quota on their home bay. Browsers see only their own
//   standing, never whether someone declined or blocked.

import { randomUUID } from "node:crypto";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import {
  createInterBayDirectClient,
  type InterBayDirectApi,
} from "@cocalc/conat/inter-bay/direct";
import {
  admitDirectRequest,
  releaseDirectRequest,
  sendDirectMessage,
  areCollaborators,
  blockDirectSender,
  clearDirectFanout,
  createDirectConversationRecord,
  getDirectConversationRecord,
  getDirectIndex,
  getDirectMessage,
  isDirectBlocked,
  listDirectIndex,
  listDirectMessages,
  markDirectRead,
  pendingDirectFanouts,
  recordDirectFanoutFailure,
  recordDirectNotified,
  setDirectMemberState,
  setDirectMuted,
  unblockDirectSender,
  upsertDirectIndex,
  type DirectFanoutRow,
  type DirectIndexRow,
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
  MAX_DIRECT_MEMBERS,
  directPairKey,
  directPreview,
  directRoute,
  memberView,
  normalizeDirectBody,
  normalizeDirectMembers,
  normalizeDirectTitle,
  normalizeDirectUsername,
  type DirectConversation,
  type DirectMemberState,
  type DirectMessage,
  type DirectResponse,
  type ListedDirectConversation,
  type MemberDirectConversation,
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
  { allowLeft = false }: { allowLeft?: boolean } = {},
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
  if (!allowLeft && (state === "declined" || state === "blocked")) {
    throw Error("conversation not found");
  }
  return { conversation, state };
}

// Deliver what the outbox holds for a conversation (or everything due).
// Each row is cleared only once its member's home bay has it.
async function deliver(rows: DirectFanoutRow[]): Promise<void> {
  await Promise.all(
    rows.map(async (row) => {
      try {
        const conversation = await getDirectConversationRecord(
          row.conversation_id,
          bay(),
        );
        if (conversation == null) {
          await clearDirectFanout(row);
          return;
        }
        const message =
          row.message_id == null
            ? null
            : await getDirectMessage(row.message_id);
        await (
          await home(row.account_id)
        ).upsertIndex({
          account_id: row.account_id,
          conversation,
          message:
            message == null
              ? null
              : {
                  message_id: message.message_id,
                  sender_id: message.sender_id,
                  body: message.body,
                },
        });
        await clearDirectFanout({ ...row, revision: conversation.revision });
      } catch (err) {
        logger.warn("direct conversation delivery failed; will retry", {
          conversation_id: row.conversation_id,
          account_id: row.account_id,
          err: `${err}`,
        });
        await recordDirectFanoutFailure({
          conversation_id: row.conversation_id,
          account_id: row.account_id,
          error: `${err}`,
        }).catch(() => {});
      }
    }),
  );
}

async function deliverNow(conversation_id: string): Promise<void> {
  await deliver(await pendingDirectFanouts({ conversation_id }));
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
  await deliver(await pendingDirectFanouts({ due: true }));
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

// On the member's home bay: should this message notify them? A request
// notifies once; otherwise each message from someone else, unless muted,
// and only once (the row records what it notified, so retries don't repeat).
function notificationFor(
  account_id: string,
  row: DirectIndexRow,
  message: Pick<DirectMessage, "message_id" | "sender_id">,
): "request" | "message" | null {
  if (message.sender_id === account_id || row.muted) return null;
  if (row.notified_message_id === message.message_id) return null;
  if (row.state === "requested") {
    return row.request_notified ? null : "request";
  }
  return row.state === "active" ? "message" : null;
}

async function notify(
  account_id: string,
  row: DirectIndexRow,
  message: Pick<DirectMessage, "message_id" | "sender_id" | "body">,
): Promise<void> {
  const kind = notificationFor(account_id, row, message);
  if (kind == null) return;
  const sender =
    (await names([message.sender_id])).get(message.sender_id) ?? "Someone";
  const summary = {
    title:
      kind === "request"
        ? `${sender} sent you a message request`
        : `Message from ${sender}`,
    // Plain text, shown as text everywhere (never parsed as Markdown, so
    // nothing in it links, loads or renders): the sender may not be accepted.
    body_text: directPreview(message.body),
    severity: "info",
    origin_label: "Messages",
    notice_type: "direct_message",
    action_label: kind === "request" ? "Review request" : "Open conversation",
    action_link: `/people/${directRoute(row.conversation_id)}`,
    conversation_id: row.conversation_id,
  };
  const homes = await resolveNotificationTargetHomeBays({
    account_ids: [account_id],
    default_bay_id: bay(),
  });
  // Idempotent by its dedupe key: safe to repeat on a retry.
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
  await recordDirectNotified({
    account_id,
    conversation_id: row.conversation_id,
    message_id: message.message_id,
    request: kind === "request",
  });
}

// An exact, current username's account (not an account id, email, or a
// redirect from an old name), or null.
async function resolveDirectUsername(value: unknown): Promise<string | null> {
  const username = normalizeDirectUsername(value);
  if (username == null) return null;
  try {
    const found = await resolveUsernameOwner(username);
    if (!found?.account_id || found.redirect) return null;
    if (`${found.username ?? ""}`.toLowerCase() !== username.toLowerCase()) {
      return null;
    }
    return found.account_id;
  } catch {
    return null;
  }
}

export const directControl: InterBayDirectApi = {
  // ---- owner ----
  async create({
    conversation_id,
    account_id,
    member_ids,
    member_states,
    title,
    pair_key,
    body,
  }) {
    requireUuid(conversation_id, "conversation_id");
    // Validate the whole envelope here, from canonical values only: the
    // starter is a member and active, states cover exactly the members, and
    // whether this is a pair (two people, no title) is derived here, never
    // taken from the caller.
    const members = normalizeDirectMembers(account_id, member_ids);
    if (
      members.length !== member_ids.length ||
      members.some((id, i) => id !== member_ids[i]?.toLowerCase())
    ) {
      throw Error("invalid members");
    }
    const canonicalTitle = normalizeDirectTitle(title);
    if ((title ?? null) !== canonicalTitle) throw Error("invalid title");
    const keys = Object.keys(member_states ?? {});
    if (
      keys.length !== members.length ||
      !members.every((id) => keys.includes(id)) ||
      member_states[members[0]] !== "active" ||
      !Object.values(member_states).every(
        (state) => state === "active" || state === "requested",
      )
    ) {
      throw Error("invalid member states");
    }
    const expectedPairKey =
      members.length === 2 && canonicalTitle == null
        ? directPairKey(members[0], members[1])
        : null;
    if ((pair_key ?? null) !== expectedPairKey) throw Error("invalid pair");
    // The right owner: a pair's one bay (the smaller account's home), or the
    // starter's home for a group.
    const expectedOwner =
      expectedPairKey != null
        ? await homeBay([...members].sort()[0])
        : await homeBay(members[0]);
    if (expectedOwner !== bay()) {
      throw Error(
        expectedPairKey != null
          ? "stale pair route"
          : "stale account-home route",
      );
    }
    const { created, conversation } = await createDirectConversationRecord({
      conversation_id,
      owner_bay_id: bay(),
      created_by: members[0],
      member_ids: members,
      member_states,
      title: canonicalTitle,
      pair_key: expectedPairKey,
      body: body == null ? null : normalizeDirectBody(body),
    });
    if (created) await deliverNow(conversation.conversation_id);
    return { created, conversation };
  },

  async messages({ account_id, conversation_id, before }) {
    const { conversation } = await memberRecord(account_id, conversation_id);
    const messages = await listDirectMessages({ conversation_id, before });
    return { conversation, messages: messages.reverse() };
  },

  async send({ account_id, conversation_id, body }) {
    await assertCanSend(account_id);
    body = normalizeDirectBody(body);
    requireUuid(conversation_id, "conversation_id");
    // Standing, replying-accepts and the consent rule are decided on the
    // locked row, together with the insert.
    const { message } = await sendDirectMessage({
      conversation_id,
      sender_id: account_id,
      body,
      owner_bay_id: bay(),
    });
    await deliverNow(conversation_id);
    return message;
  },

  async respond({ account_id, conversation_id, action }) {
    // Accepting also works after declining or blocking (starting to talk to
    // them again).
    const { conversation: before } = await memberRecord(
      account_id,
      conversation_id,
      { allowLeft: action === "accept" },
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
    if (before.created_by !== account_id) {
      // Blocks live on the blocker's home bay.
      const mine = await home(account_id);
      if (action === "block") {
        await mine.block({ account_id, blocked_account_id: before.created_by });
      } else if (action === "accept") {
        await mine.unblock({
          account_id,
          blocked_account_id: before.created_by,
        });
      }
    }
    const conversation = await setDirectMemberState({
      conversation_id,
      account_id,
      state,
      owner_bay_id: bay(),
    });
    if (conversation == null) throw Error("conversation not found");
    await deliverNow(conversation_id);
    return conversation;
  },

  async standings({ account_id, conversation_id }) {
    const { conversation } = await memberRecord(account_id, conversation_id, {
      allowLeft: true,
    });
    return conversation.member_states;
  },

  // ---- home ----
  // Collaborators by account id; anyone else only by exact username,
  // resolved here, so the browser can't turn an account id into a request.
  async start({ account_id, member_ids, usernames, title, body }) {
    await assertHome(account_id);
    await assertCanSend(account_id);
    // Bound what the browser sent before any lookup: the final, deduplicated
    // check is normalizeDirectMembers below.
    if (
      !Array.isArray(member_ids ?? []) ||
      !Array.isArray(usernames ?? []) ||
      (member_ids ?? []).length + (usernames ?? []).length >
        MAX_DIRECT_MEMBERS - 1
    ) {
      throw Error(`at most ${MAX_DIRECT_MEMBERS} people in a conversation`);
    }
    const collaborators = new Set<string>();
    for (const id of member_ids ?? []) {
      requireUuid(id, "member_ids");
      if (!(await areCollaborators(account_id, id, bay()))) {
        throw Error(
          "add people who aren't your collaborators by their username",
        );
      }
      collaborators.add(id.toLowerCase());
    }
    const byUsername: string[] = [];
    for (const name of usernames ?? []) {
      const resolved = await resolveDirectUsername(name);
      if (resolved == null) {
        throw Error(`no one has the username "${`${name}`.slice(0, 64)}"`);
      }
      byUsername.push(resolved);
    }
    const members = normalizeDirectMembers(account_id, [
      ...collaborators,
      ...byUsername,
    ]);
    const normalizedTitle = normalizeDirectTitle(title);
    const text = body == null || `${body}`.trim() === "" ? null : body;
    if (text != null) normalizeDirectBody(text);
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
      states[other] =
        collaborators.has(other) ||
        (await areCollaborators(account_id, other, bay()))
          ? "active"
          : "requested";
    }
    const pair = members.length === 2 && normalizedTitle == null;
    const pair_key = pair ? directPairKey(members[0], members[1]) : null;
    const ownerBay = pair ? await homeBay([...members].sort()[0]) : bay();
    const requests = Object.values(states).filter(
      (s) => s === "requested",
    ).length;

    const conversation_id = randomUUID();
    // A request is charged before it is created. The charge is released only
    // on proof that this attempt created nothing: the pair already had a
    // different conversation. An error (a lost reply, a timeout after the
    // owner committed) keeps it.
    if (requests > 0) {
      await admitDirectRequest({
        account_id,
        conversation_id,
        recipients: requests,
      });
    }
    const result = await owner(ownerBay).create({
      conversation_id,
      account_id,
      member_ids: members,
      member_states: states,
      title: normalizedTitle,
      pair_key,
      body: text,
    });
    // A retried create of this same conversation reports it as existing:
    // it is still this attempt's.
    const ours = result.conversation.conversation_id === conversation_id;
    if (requests > 0 && !ours) {
      await releaseDirectRequest(conversation_id);
    }
    const created = result.created || ours;
    const { conversation } = result;
    if (!created) {
      // The pair's conversation exists: rejoin it if this account had left
      // it, then send (with the usual first-message rule).
      const mine = conversation.member_states[account_id] ?? "active";
      if (mine === "declined" || mine === "blocked") {
        await owner(ownerBay).respond({
          account_id,
          conversation_id: conversation.conversation_id,
          action: "accept",
        });
      }
      if (text != null) {
        await owner(ownerBay).send({
          account_id,
          conversation_id: conversation.conversation_id,
          body: text,
        });
      }
    }
    // Normally delivered by now; if this bay's own copy is still pending,
    // answer from the record (the outbox delivers it later).
    return (
      (await getDirectIndex(account_id, conversation.conversation_id)) ?? {
        ...conversation,
        state: conversation.member_states[account_id] ?? "active",
        last_read: null,
        muted: false,
      }
    );
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
    // A request from someone this member blocked is never recorded or
    // notified, even if the block landed after the starter checked it.
    if (
      (conversation.member_states[account_id] ?? "active") === "requested" &&
      (await isDirectBlocked(account_id, conversation.created_by))
    ) {
      return;
    }
    const row = await upsertDirectIndex({ account_id, conversation });
    // A failure here is retried by the owning bay (the notification is
    // idempotent and recorded once created).
    if (message != null) await notify(account_id, row, message);
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

  async unblock({ account_id, blocked_account_id }) {
    await assertHome(account_id);
    requireUuid(blocked_account_id, "blocked_account_id");
    await unblockDirectSender(account_id, blocked_account_id);
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

function asMember(
  listed: ListedDirectConversation,
  conversation: DirectConversation,
  account_id: string,
): MemberDirectConversation {
  return memberView({
    ...listed,
    ...conversation,
    state: conversation.member_states[account_id] ?? listed.state,
  });
}

// Everything returned to a browser goes through memberView: the caller's own
// standing only, never whether someone else declined or blocked.
export const directHubApi = {
  async listDirect({
    account_id,
  }: {
    account_id?: string;
  }): Promise<{ conversations: MemberDirectConversation[] }> {
    const listed = await (
      await home(account_id!)
    ).list({ account_id: account_id! });
    return { conversations: listed.map(memberView) };
  },

  async startDirect({
    account_id,
    member_ids,
    usernames,
    title,
    body,
  }: {
    account_id?: string;
    member_ids?: string[];
    usernames?: string[];
    title?: string | null;
    body?: string | null;
  }): Promise<MemberDirectConversation> {
    return memberView(
      await (
        await home(account_id!)
      ).start({
        account_id: account_id!,
        member_ids: member_ids ?? [],
        usernames: usernames ?? [],
        title,
        body,
      }),
    );
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
  }): Promise<{
    conversation: MemberDirectConversation;
    messages: DirectMessage[];
  }> {
    const listed = await listedOrThrow(account_id!, conversation_id);
    const { conversation, messages } = await owner(
      listed.owner_bay_id,
    ).messages({ account_id: account_id!, conversation_id, before });
    return {
      conversation: asMember(listed, conversation, account_id!),
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
  }): Promise<DirectMessage> {
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
  }): Promise<MemberDirectConversation> {
    const listed = await listedOrThrow(account_id!, conversation_id);
    const conversation = await owner(listed.owner_bay_id).respond({
      account_id: account_id!,
      conversation_id,
      action,
    });
    return asMember(listed, conversation, account_id!);
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
  // personal URLs); never by account id or email address. To message them,
  // start with the username: the account id here only labels the choice.
  async findDirectRecipient({
    username,
  }: {
    account_id?: string;
    username: string;
  }): Promise<{ account_id: string; name: string; username: string } | null> {
    const value = normalizeDirectUsername(username);
    if (value == null) return null;
    const account_id = await resolveDirectUsername(value);
    if (account_id == null) return null;
    const name = (await names([account_id])).get(account_id) ?? value;
    return { account_id, name, username: value };
  },
};
