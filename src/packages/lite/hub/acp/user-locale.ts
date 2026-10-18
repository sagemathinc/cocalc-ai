/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  formatAgentUserTimeContext,
  normalizeAgentUserLocale,
  type AgentUserLocale,
} from "@cocalc/util/ai/agent-user-locale";
import { isValidUUID } from "@cocalc/util/misc";
import { getRow, upsertRow } from "../sqlite/database";

const TABLE = "acp-user-locale";

/**
 * The account's latest time zone and place. A turn sent from a browser
 * carries them and they are remembered; a turn no browser started (a sensor
 * wake, another agent's message) uses the remembered ones.
 */
export function rememberAgentUserLocale(
  account_id: string | undefined,
  sent: unknown,
): AgentUserLocale | undefined {
  const fresh = normalizeAgentUserLocale(sent);
  if (!isValidUUID(account_id)) return fresh;
  try {
    if (fresh) {
      upsertRow(TABLE, account_id!, { ...fresh, updated_at: Date.now() });
      return fresh;
    }
    return normalizeAgentUserLocale(getRow(TABLE, account_id!));
  } catch {
    return fresh;
  }
}

/** The line for this turn's context, or undefined if the zone is unknown. */
export function agentUserTimeContext(
  account_id: string | undefined,
  sent: unknown,
  now?: Date,
): string | undefined {
  return formatAgentUserTimeContext(
    rememberAgentUserLocale(account_id, sent),
    now,
  );
}
