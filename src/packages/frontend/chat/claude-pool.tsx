/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Auto: Claude Code agents that pay with any of the account's Claude
// subscriptions, one picked for each turn (on the server). Here: which
// subscriptions Auto may use, and how long they last at the recent rate.

import { Checkbox, Typography } from "antd";
import { useState } from "react";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { claudeSubscriptionName } from "@cocalc/frontend/agents/claude-credential-options";
import {
  CLAUDE_POOL_EXCLUDED_METADATA_KEY,
  CLAUDE_TURN_COSTS_METADATA_KEY,
  claudePoolAvailableAt,
  claudePoolForecast,
  claudePoolMemberFromMetadata,
  claudeTurnCostEstimate,
  parseTurnCostSamples,
} from "@cocalc/util/ai/claude-pool";
import { CLAUDE_SUBSCRIPTION_KIND } from "@cocalc/util/ai/external-credential-profiles";

/** The picker value of Auto. */
export const CLAUDE_POOL_VALUE = "subscription-pool";
export const CLAUDE_POOL_LABEL = "Auto: Claude subscriptions";
export const CLAUDE_POOL_OPTION_LABEL =
  "Auto: choose a Claude subscription for each turn";

function subscriptions(credentials: ExternalCredentialInfo[]) {
  return credentials.filter(
    (row) => !row.revoked && row.kind === CLAUDE_SUBSCRIPTION_KIND,
  );
}

export function inClaudePool(row: ExternalCredentialInfo): boolean {
  return row.metadata?.[CLAUDE_POOL_EXCLUDED_METADATA_KEY] !== true;
}

export interface ClaudePoolSummary {
  members: number;
  /** Members with room for a large turn now. */
  available: number;
  /** Weekly limits left, summed over the members. */
  remaining: number;
  runsOutAt?: number;
  /** When one has room again, if none has now. */
  nextAvailableAt?: number;
}

export function claudePoolSummary(
  credentials: ExternalCredentialInfo[],
  now = Date.now(),
): ClaudePoolSummary {
  const pool = subscriptions(credentials).filter(inClaudePool);
  const members = pool.map((row) =>
    claudePoolMemberFromMetadata(row.id, row.metadata, now),
  );
  const cost = claudeTurnCostEstimate(
    pool.flatMap((row) =>
      parseTurnCostSamples(row.metadata?.[CLAUDE_TURN_COSTS_METADATA_KEY]),
    ),
  );
  const times = members.map((m) => claudePoolAvailableAt(m, cost, now));
  const available = times.filter((t) => t <= now).length;
  const forecast = claudePoolForecast(members, now);
  return {
    members: members.length,
    available,
    remaining: forecast.remaining,
    ...(forecast.runsOutAt != null ? { runsOutAt: forecast.runsOutAt } : {}),
    ...(available === 0 && times.length > 0
      ? { nextAvailableAt: Math.min(...times) }
      : {}),
  };
}

/** One or two lines: how much the pool has left, and how long it lasts. */
export function ClaudePoolForecast({
  credentials,
}: {
  credentials: ExternalCredentialInfo[];
}) {
  const summary = claudePoolSummary(credentials);
  if (summary.members === 0)
    return (
      <Typography.Text type="warning" style={{ fontSize: 12 }}>
        Auto has no subscription to use: check one, or connect one.
      </Typography.Text>
    );
  return (
    <div style={{ fontSize: 12 }} role="status">
      <div>
        {summary.available} of {summary.members} subscription
        {summary.members === 1 ? "" : "s"} with room now
        {summary.nextAvailableAt != null && (
          <>
            ; next <TimeAgo date={new Date(summary.nextAvailableAt)} />
          </>
        )}
        . About {summary.remaining.toFixed(1)} of {summary.members} weekly
        limits left.
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {summary.runsOutAt != null ? (
          <>
            At the recent rate, every weekly limit is reached{" "}
            <TimeAgo date={new Date(summary.runsOutAt)} /> (
            {new Date(summary.runsOutAt).toLocaleString(undefined, {
              weekday: "short",
              hour: "numeric",
              minute: "2-digit",
            })}
            ).
          </>
        ) : (
          "At the recent rate, the weekly limits last until they reset."
        )}
      </Typography.Text>
    </div>
  );
}

/**
 * Auto's settings: which subscriptions it may use (all by default), and the
 * forecast. Membership is per account: it applies to every Auto agent.
 */
export function ClaudePoolPanel({
  credentials,
  onCredentials,
  disabled,
}: {
  credentials: ExternalCredentialInfo[];
  /** The list after a change, shown at once. */
  onCredentials?: (rows: ExternalCredentialInfo[]) => void;
  disabled?: boolean;
}) {
  const [saving, setSaving] = useState<string>();
  const [error, setError] = useState("");
  const rows = subscriptions(credentials);
  async function toggle(row: ExternalCredentialInfo, in_pool: boolean) {
    setSaving(row.id);
    setError("");
    try {
      await webapp_client.conat_client.hub.system.setClaudeSubscriptionInPool({
        id: row.id,
        in_pool,
      });
      onCredentials?.(
        credentials.map((r) =>
          r.id === row.id
            ? {
                ...r,
                metadata: {
                  ...r.metadata,
                  [CLAUDE_POOL_EXCLUDED_METADATA_KEY]: !in_pool,
                },
              }
            : r,
        ),
      );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(undefined);
    }
  }
  return (
    <div
      role="group"
      aria-label="Subscriptions Auto uses"
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Each turn uses the subscription whose weekly limit resets soonest among
        those with room for a large turn, and an agent moves to another when one
        reaches its limit. These apply to all your Auto agents:
      </Typography.Text>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {rows.map((row) => (
          <Checkbox
            key={row.id}
            checked={inClaudePool(row)}
            disabled={disabled || saving != null}
            onChange={(event) => void toggle(row, event.target.checked)}
          >
            {claudeSubscriptionName(row, true)}
          </Checkbox>
        ))}
      </div>
      <ClaudePoolForecast credentials={credentials} />
      {error && (
        <div role="alert" style={{ fontSize: 12 }}>
          Could not change Auto: {error}
        </div>
      )}
    </div>
  );
}
