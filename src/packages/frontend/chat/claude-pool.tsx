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
  /** Weekly limits used per day at the recent rate (see rateFrom). */
  usedPerDay?: number;
  rateFrom?: "recent" | "week";
  rateHours?: number;
  runsOutAt?: number;
  /** The most weekly limits a day that last a week (see claudePoolForecast). */
  maxPerDay?: number;
  /** The subscription to spend first: the soonest reset with room left. */
  useFirst?: { name: string; left: number; resetsAt: number };
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
    // A measured recent rate counts even when it is 0 (used earlier in the
    // week, idle lately); an estimate of 0 says nothing.
    ...(forecast.ratePerHour > 0 || forecast.rateFrom === "recent"
      ? {
          usedPerDay: forecast.ratePerHour * 24,
          rateFrom: forecast.rateFrom,
          ...(forecast.rateHours != null
            ? { rateHours: forecast.rateHours }
            : {}),
        }
      : {}),
    ...(forecast.runsOutAt != null ? { runsOutAt: forecast.runsOutAt } : {}),
    ...(forecast.maxRatePerHour != null
      ? { maxPerDay: forecast.maxRatePerHour * 24 }
      : {}),
    ...(forecast.useFirst
      ? {
          useFirst: {
            name: claudeSubscriptionName(
              pool.find((row) => row.id === forecast.useFirst!.credential_id)!,
              true,
            ),
            left: forecast.useFirst.left,
            resetsAt: forecast.useFirst.resetsAt,
          },
        }
      : {}),
    ...(available === 0 && times.length > 0
      ? { nextAvailableAt: Math.min(...times) }
      : {}),
  };
}

// weekly limits a day: two decimals below one, so small rates don't read as 0
function perDay(x: number): string {
  return x < 1 ? x.toFixed(2) : x.toFixed(1);
}

// How fast the weekly limits are used against how fast they renew.  The
// recent rate is measured; before there is enough recent history it is
// estimated from each current week's average, which runs high when the weeks
// are staggered and the turns went to a few subscriptions.
// How many subscriptions keep up with that rate: each renews one weekly limit
// a week.  (Usage is a share of each subscription's own limit, so this counts
// subscriptions like the ones in the pool.)
export function claudePoolSubscriptionsNeeded(usedPerDay: number): number {
  return Math.max(1, Math.ceil(usedPerDay * 7 - 1e-9));
}

function rateLine(summary: ClaudePoolSummary, usedPerDay: number): string {
  const renew = `${summary.members} subscription${
    summary.members === 1 ? " renews" : "s renew"
  } about ${perDay(summary.members / 7)} a day`;
  const need = claudePoolSubscriptionsNeeded(usedPerDay);
  const needed = `At that rate, ${need} subscription${need === 1 ? "" : "s"} like these would keep up; you have ${summary.members}.`;
  if (summary.rateFrom === "recent" && summary.rateHours != null) {
    const hours = Math.round(summary.rateHours);
    return `Using about ${perDay(usedPerDay)} weekly limits a day (over the last ${hours} hour${
      hours === 1 ? "" : "s"
    }); ${renew}. ${needed}`;
  }
  return `Estimated at about ${perDay(usedPerDay)} weekly limits a day from the current weeks' averages (likely high until there is more recent history); ${renew}. ${needed}`;
}

// How much more could be used: the room each subscription loses unused at its
// reset is the reason a pool can run well below its limits and still waste
// capacity.
export function paceLine(summary: ClaudePoolSummary): string | undefined {
  // Only with a rate to compare it with: with no usage readings at all, the
  // subscriptions' room is not known either.
  if (summary.maxPerDay == null || summary.usedPerDay == null) return undefined;
  const max = summary.maxPerDay;
  const used = summary.usedPerDay;
  const compared =
    used > 0 && max > used * 1.05
      ? ` That is about ${(max / used).toFixed(1)} times the recent rate: there is room to use more.`
      : max < used * 0.95
        ? " That is less than the recent rate."
        : " That is about the recent rate.";
  return `Up to about ${perDay(max)} weekly limits a day would last the coming week, counting the resets on the way and what each subscription loses unused when it resets.${compared}`;
}

/** How much the pool has left, how fast it is used against how fast it
 * renews, how long it lasts, and how much more it could take. */
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
      {summary.usedPerDay != null && (
        <div>{rateLine(summary, summary.usedPerDay)}</div>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {summary.usedPerDay == null ? (
          "No usage rate is available to forecast from."
        ) : summary.runsOutAt != null ? (
          <>
            At that rate, counting the resets on the way, every weekly limit is
            reached <TimeAgo date={new Date(summary.runsOutAt)} /> (
            {new Date(summary.runsOutAt).toLocaleString(undefined, {
              weekday: "short",
              hour: "numeric",
              minute: "2-digit",
            })}
            ).
          </>
        ) : (
          "At that rate, counting the resets on the way, they don't all run out within a week."
        )}
      </Typography.Text>
      {paceLine(summary) && <div>{paceLine(summary)}</div>}
      {summary.useFirst && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Next to reset: {summary.useFirst.name}, with{" "}
          {Math.round(summary.useFirst.left * 100)}% left,{" "}
          <TimeAgo date={new Date(summary.useFirst.resetsAt)} /> (Auto spends it
          first).
        </Typography.Text>
      )}
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
