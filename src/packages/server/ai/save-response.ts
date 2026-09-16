import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { pii_retention_to_future } from "@cocalc/database/postgres/account/pii";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { AIUsageLogEntry } from "@cocalc/util/db-schema/ai-log";
import { ensureAccountUsageWindowsForEvent } from "@cocalc/server/membership/usage-windows";
import { AI_USAGE_UNITS_PER_DOLLAR } from "./usage-units";
import type { SiteFundedCodexUsageEvent } from "@cocalc/util/ai/site-funded-codex";

const log = getLogger("ai:save-response");

// time, id is set by the database, and expire in the saveAIResponse function
type SaveAIResponseProps = Omit<AIUsageLogEntry, "time" | "id" | "expire"> & {
  occurred_at?: Date | string;
};

let ensuredExactUsageSchema: Promise<void> | undefined;

export async function ensureExactAIUsageSchema(): Promise<void> {
  if (!ensuredExactUsageSchema) {
    ensuredExactUsageSchema = (async () => {
      const pool = getPool();
      await pool.query(
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS cost_microusd BIGINT",
      );
      await pool.query(
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS funded_turn_id UUID",
      );
      await pool.query(
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS funded_event_id UUID",
      );
      for (const statement of [
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS cached_input_tokens BIGINT",
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS cache_write_input_tokens BIGINT",
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS output_tokens BIGINT",
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS price_version TEXT",
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS provider_request_id TEXT",
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS provider_tool_fees_microusd BIGINT",
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS reasoning_output_tokens BIGINT",
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS request_sequence INTEGER",
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS long_context BOOLEAN",
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS media_operation TEXT",
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS audio_duration_ms BIGINT",
        "ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS input_characters BIGINT",
      ]) {
        await pool.query(statement);
      }
      await pool.query(
        "DROP INDEX IF EXISTS ai_usage_log_funded_turn_id_unique_idx",
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ai_usage_log_funded_turn_id_idx
           ON ai_usage_log(funded_turn_id) WHERE funded_turn_id IS NOT NULL`,
      );
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_log_funded_event_id_unique_idx
           ON ai_usage_log(funded_event_id) WHERE funded_event_id IS NOT NULL`,
      );
    })().catch((err) => {
      ensuredExactUsageSchema = undefined;
      throw err;
    });
  }
  await ensuredExactUsageSchema;
}

// Save the response to the historical AI usage log table.
export async function saveAIResponse({
  account_id,
  analytics_cookie,
  cached_input_tokens,
  cache_write_input_tokens,
  cost_microusd,
  funded_event_id,
  funded_turn_id,
  history,
  input,
  model,
  occurred_at,
  output,
  output_tokens,
  path,
  project_id,
  prompt_tokens,
  price_version,
  provider_request_id,
  provider_tool_fees_microusd,
  reasoning_output_tokens,
  request_sequence,
  long_context,
  media_operation,
  audio_duration_ms,
  input_characters,
  system,
  tag,
  total_time_s,
  total_tokens,
  usage_units,
}: SaveAIResponseProps): Promise<boolean> {
  const expire: AIUsageLogEntry["expire"] = await getExpiration(account_id);
  const pool = getPool();
  try {
    await ensureExactAIUsageSchema();
    if (account_id) {
      await ensureAccountUsageWindowsForEvent({
        account_id,
        occurred_at,
      });
    }
    await pool.query(
      `INSERT INTO ai_usage_log(
         time,input,system,output,history,account_id,analytics_cookie,project_id,
         path,total_tokens,prompt_tokens,total_time_s,expire,model,tag,
         usage_units,cost_microusd,funded_turn_id,funded_event_id,
         cached_input_tokens,cache_write_input_tokens,output_tokens,
         price_version,provider_request_id,provider_tool_fees_microusd,
         reasoning_output_tokens,request_sequence,long_context,
         media_operation,audio_duration_ms,input_characters
       ) VALUES(
         COALESCE($31::timestamptz, NOW()),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30
       ) ON CONFLICT (funded_event_id) WHERE funded_event_id IS NOT NULL DO NOTHING`,
      [
        input,
        system,
        output,
        history,
        account_id,
        analytics_cookie,
        project_id,
        path,
        total_tokens,
        prompt_tokens,
        total_time_s,
        expire,
        model,
        tag,
        usage_units ?? null,
        cost_microusd ??
          (usage_units == null
            ? null
            : Math.max(
                0,
                Math.round(
                  (usage_units * 1_000_000) / AI_USAGE_UNITS_PER_DOLLAR,
                ),
              )),
        funded_turn_id ?? null,
        funded_event_id ?? null,
        cached_input_tokens ?? null,
        cache_write_input_tokens ?? null,
        output_tokens ?? null,
        price_version ?? null,
        provider_request_id ?? null,
        provider_tool_fees_microusd ?? null,
        reasoning_output_tokens ?? null,
        request_sequence ?? null,
        long_context ?? null,
        media_operation ?? null,
        audio_duration_ms ?? null,
        input_characters ?? null,
        occurred_at ?? null,
      ],
    );
    return true;
  } catch (err) {
    log.warn("Failed to save AI usage log entry to database:", err);
    return false;
  }
}

export async function recordSiteFundedCodexAccountUsage({
  account_id,
  funded_turn_id,
  project_id,
  event,
  cost_microusd,
  price_version,
  long_context,
  occurred_at,
}: {
  account_id: string;
  funded_turn_id: string;
  project_id: string;
  event: SiteFundedCodexUsageEvent;
  cost_microusd: number;
  price_version: string;
  long_context: boolean;
  occurred_at?: Date | string;
}): Promise<void> {
  if (!Number.isSafeInteger(cost_microusd) || cost_microusd < 0) {
    throw new Error("cost_microusd must be a nonnegative safe integer");
  }
  const saved = await saveAIResponse({
    account_id,
    analytics_cookie: undefined,
    cached_input_tokens: event.cachedInputTokens ?? 0,
    cache_write_input_tokens: event.cacheWriteInputTokens ?? 0,
    cost_microusd,
    funded_event_id: event.eventId,
    funded_turn_id,
    history: [],
    input: `[site-funded-codex-request:${event.requestSequence}]`,
    long_context,
    model: event.model,
    output: "",
    output_tokens: event.outputTokens,
    occurred_at,
    project_id,
    price_version,
    prompt_tokens: event.inputTokens,
    provider_request_id: event.providerRequestId,
    provider_tool_fees_microusd: event.providerToolFeesMicrousd ?? 0,
    reasoning_output_tokens: event.reasoningOutputTokens ?? 0,
    request_sequence: event.requestSequence,
    system: "",
    tag: "site-funded-codex",
    total_time_s: Math.max(0, (event.durationMs ?? 0) / 1_000),
    total_tokens: event.inputTokens + event.outputTokens,
    usage_units: undefined,
  });
  if (!saved) {
    throw new Error("failed to record site-funded Codex account usage");
  }
}

async function getExpiration(account_id: string | undefined) {
  // NOTE about expire: If the admin setting for "PII Retention" is set *and*
  // the usage is only identified by their analytics_cookie, then
  // we automatically delete the AI usage log at the expiration time.
  // If the account_id *is* set, users can:
  // 1. Delete their past AI usage.
  // 2. Have past AI usage deleted when they delete their account.
  // 3. Search and inspect their past usage.
  // See https://github.com/sagemathinc/cocalc/issues/6577
  if (account_id == null) {
    const { pii_retention } = await getServerSettings();
    return pii_retention_to_future(pii_retention);
  } else {
    return undefined;
  }
}
