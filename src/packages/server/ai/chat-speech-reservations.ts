/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { ensureAccountUsageWindowsForEvent } from "@cocalc/server/membership/usage-windows";
import { AI_USAGE_UNITS_PER_DOLLAR } from "./usage-units";
import { ensureExactAIUsageSchema } from "./save-response";
import { getAIUsageStatus } from "./usage-status";

const RESERVATION_TAG = "chat-speech-reservation";
const RESERVATION_TTL_MS = 5 * 60_000;

export interface ChatSpeechUsageReservation {
  accountId: string;
  requestId: string;
  reservedMicrousd: number;
}

function codedError(message: string, code: number): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

function microusdToUsageUnits(microusd: number): number {
  return (microusd * AI_USAGE_UNITS_PER_DOLLAR) / 1_000_000;
}

export async function reserveChatSpeechUsage({
  accountId,
  requestId,
  operation,
  model,
  reservedMicrousd,
}: {
  accountId: string;
  requestId: string;
  operation: "transcription" | "speech";
  model: string;
  reservedMicrousd: number;
}): Promise<ChatSpeechUsageReservation> {
  if (!Number.isSafeInteger(reservedMicrousd) || reservedMicrousd <= 0) {
    throw new Error("reservedMicrousd must be a positive safe integer");
  }
  await ensureExactAIUsageSchema();
  await ensureAccountUsageWindowsForEvent({ account_id: accountId });
  const status = await getAIUsageStatus({ account_id: accountId });
  if (
    status.windows.some(
      ({ limit, starts_at, resets_at }) =>
        typeof limit !== "number" ||
        limit <= 0 ||
        starts_at == null ||
        resets_at == null,
    )
  ) {
    throw codedError("Your site-funded AI allowance is exhausted.", 403);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const account = await client.query(
      "SELECT account_id FROM accounts WHERE account_id=$1 FOR UPDATE",
      [accountId],
    );
    if (account.rows.length !== 1) {
      throw codedError("The account is unavailable.", 404);
    }
    await client.query(
      `DELETE FROM ai_usage_log
       WHERE account_id=$1 AND tag=$2
         AND time < NOW() - ($3::BIGINT * INTERVAL '1 millisecond')`,
      [accountId, RESERVATION_TAG, RESERVATION_TTL_MS],
    );

    const requestedUnits = microusdToUsageUnits(reservedMicrousd);
    for (const window of status.windows) {
      const { rows } = await client.query(
        `SELECT SUM(COALESCE(
           cost_microusd * $4::numeric / 1000000,
           usage_units,
           0
         )) AS used
         FROM ai_usage_log
         WHERE account_id=$1 AND time >= $2 AND time < $3`,
        [
          accountId,
          window.starts_at,
          window.resets_at,
          AI_USAGE_UNITS_PER_DOLLAR,
        ],
      );
      const used = Number(rows[0]?.used ?? 0);
      if (used + requestedUnits > (window.limit as number)) {
        throw codedError("Your site-funded AI allowance is exhausted.", 403);
      }
    }

    await client.query(
      `INSERT INTO ai_usage_log(
         time, input, output, history, account_id, total_tokens,
         prompt_tokens, total_time_s, model, tag, cost_microusd,
         funded_event_id, price_version, media_operation
       ) VALUES(
         NOW(), '[chat-speech-reservation]', '', ARRAY[]::JSONB[], $1, 0,
         0, 0, $2, $3, $4, $5, 'openai-chat-speech-2026-09-08', $6
       )`,
      [
        accountId,
        model,
        RESERVATION_TAG,
        reservedMicrousd,
        requestId,
        operation,
      ],
    );
    await client.query("COMMIT");
    return { accountId, requestId, reservedMicrousd };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function settleChatSpeechUsage({
  reservation,
  projectId,
  path,
  operation,
  model,
  costMicrousd,
  durationMs,
  inputCharacters,
  providerRequestId,
  elapsedMs,
}: {
  reservation: ChatSpeechUsageReservation;
  projectId?: string;
  path?: string;
  operation: "transcription" | "speech";
  model: string;
  costMicrousd: number;
  durationMs: number;
  inputCharacters?: number;
  providerRequestId?: string;
  elapsedMs: number;
}): Promise<void> {
  if (
    !Number.isSafeInteger(costMicrousd) ||
    costMicrousd <= 0 ||
    costMicrousd > reservation.reservedMicrousd
  ) {
    throw new Error("speech settlement exceeds its reservation");
  }
  const { rows } = await getPool().query(
    `UPDATE ai_usage_log SET
       input=$3, tag=$4, cost_microusd=$5, project_id=$6, path=$7,
       model=$8, provider_request_id=$9, total_time_s=$10,
       audio_duration_ms=$11, input_characters=$12
     WHERE account_id=$1 AND funded_event_id=$2 AND tag=$13
     RETURNING funded_event_id`,
    [
      reservation.accountId,
      reservation.requestId,
      `[chat-speech-${operation}]`,
      `chat-speech-${operation}`,
      costMicrousd,
      projectId ?? null,
      path ?? null,
      model,
      providerRequestId ?? null,
      Math.max(0, elapsedMs / 1_000),
      Math.round(durationMs),
      inputCharacters ?? null,
      RESERVATION_TAG,
    ],
  );
  if (rows.length !== 1)
    throw new Error("speech usage reservation was not found");
}

export async function releaseChatSpeechUsage(
  reservation: ChatSpeechUsageReservation,
): Promise<void> {
  await getPool().query(
    `DELETE FROM ai_usage_log
     WHERE account_id=$1 AND funded_event_id=$2 AND tag=$3`,
    [reservation.accountId, reservation.requestId, RESERVATION_TAG],
  );
}
