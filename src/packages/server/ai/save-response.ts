import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { pii_retention_to_future } from "@cocalc/database/postgres/account/pii";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { AIUsageLogEntry } from "@cocalc/util/db-schema/ai-log";

const log = getLogger("ai:save-response");

// time, id is set by the database, and expire in the saveAIResponse function
type SaveAIResponseProps = Omit<AIUsageLogEntry, "time" | "id" | "expire">;

// Save the response to the historical AI usage log table.
export async function saveAIResponse({
  account_id,
  analytics_cookie,
  history,
  input,
  model,
  output,
  path,
  project_id,
  prompt_tokens,
  system,
  tag,
  total_time_s,
  total_tokens,
  usage_units,
}: SaveAIResponseProps) {
  const expire: AIUsageLogEntry["expire"] = await getExpiration(account_id);
  const pool = getPool();
  try {
    await pool.query(
      "INSERT INTO ai_usage_log(time,input,system,output,history,account_id,analytics_cookie,project_id,path,total_tokens,prompt_tokens,total_time_s,expire,model,tag,usage_units) VALUES(NOW(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
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
      ],
    );
  } catch (err) {
    log.warn("Failed to save AI usage log entry to database:", err);
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
