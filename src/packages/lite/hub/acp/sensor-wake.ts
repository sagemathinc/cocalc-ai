/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Deliver a sensor wake: a turn in the agent's thread that CoCalc writes on
// behalf of an approved sensor. It goes through the same preparation and
// admission as a person's message, so it works for Codex, Claude Code and
// other ACP harnesses, and it queues behind a running turn.

import type { Client } from "@cocalc/conat/core/client";
import type {
  SensorWakeDelivery,
  SensorWakeDeliveryResult,
} from "@cocalc/conat/agents/sensors";
import { prepareChatSend, admitPreparedChatSend } from "@cocalc/chat/send";
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";

const errorText = (err: unknown) =>
  `${err instanceof Error ? err.message : err}`.slice(0, 500);

/**
 * Failures before the message is written are reported as not_sent: nothing
 * can start a turn from them, so the hub may count the wake as unused. Any
 * later failure is thrown, because the turn may already be queued.
 */
export async function deliverSensorWake(
  client: Client,
  wake: SensorWakeDelivery,
  ensureRunning: () => Promise<void>,
): Promise<SensorWakeDeliveryResult> {
  const { project_id } = wake.authorization;
  try {
    await ensureRunning();
  } catch (err) {
    return { not_sent: `the project did not start: ${errorText(err)}` };
  }
  let db: Awaited<ReturnType<typeof acquireChatSyncDB>>;
  try {
    db = await acquireChatSyncDB({
      client,
      project_id,
      path: wake.path,
      readyTimeoutMs: 10_000,
    });
  } catch (err) {
    return { not_sent: `the agent's chat did not open: ${errorText(err)}` };
  }
  try {
    let prepared: ReturnType<typeof prepareChatSend>;
    try {
      const current = db.get();
      const rows = Array.isArray(current) ? current : (current?.toJS?.() ?? []);
      const thread = rows.find(
        (row) =>
          row.event === "chat-thread-config" &&
          row.thread_id === wake.thread_id,
      );
      if (!thread || thread.archived)
        return { not_sent: "the agent's thread is unavailable" };
      prepared = prepareChatSend({
        projectId: project_id,
        accountId: wake.account_id,
        path: wake.path,
        thread,
        rows,
        prompt: wake.prompt,
      });
    } catch (err) {
      return { not_sent: errorText(err) };
    }
    // Agent-authored, not a person's words: no mention binding or account
    // API keys, and the hub rechecks the approval before the turn executes.
    prepared.request.chat.agent_message = true;
    prepared.request.chat.sensor_wake = { ...wake.authorization };
    db.set({
      ...prepared.message,
      // Display metadata only, never an authorization input.
      sensor_wake: {
        sensor_id: wake.authorization.sensor_id,
        run_id: wake.authorization.run_id,
        title: wake.title,
      },
    });
    db.commit();
    await db.save();
    await db.save_to_disk();
    await admitPreparedChatSend({ prepared, client, timeoutMs: 15_000 });
    return { message_id: `${prepared.message.message_id ?? ""}` };
  } finally {
    await releaseChatSyncDB(project_id, wake.path);
  }
}
