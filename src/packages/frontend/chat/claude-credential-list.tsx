/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Progress, Radio, Tooltip, Typography } from "antd";
import { useState } from "react";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import { CLAUDE_SUBSCRIPTION_KIND } from "@cocalc/util/ai/external-credential-profiles";
import {
  CLAUDE_USAGE_METADATA_KEY,
  claudeSubscriptionUsage,
  type ClaudeUsageWindow,
} from "@cocalc/util/ai/claude-usage";
import { Icon } from "@cocalc/frontend/components/icon";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { newAgentClaudeCredentialOptions } from "@cocalc/frontend/agents/claude-credential-options";

/**
 * A warning when, at the rate used so far in this window, its limit would be
 * hit before it resets (a linear estimate). Tap or hover for details, so it
 * also works on a phone.
 */
export function ClaudeUsageLimitWarning({
  window,
}: {
  window: ClaudeUsageWindow;
}) {
  const [open, setOpen] = useState(false);
  const projection = window.projection;
  if (!projection) return null;
  const name = window.name.replace(/\s*\(.*\)$/, "").toLowerCase();
  return (
    <Tooltip
      open={open}
      onOpenChange={setOpen}
      trigger={["hover", "focus", "click"]}
      title={
        <>
          At this rate, the {name} limit is reached{" "}
          <TimeAgo date={projection.limitAt} />, before it resets (about{" "}
          {projection.percentAtReset}% by then). A linear estimate from the
          latest report.
        </>
      }
    >
      <button
        type="button"
        aria-label={`${window.name}: on pace to reach the limit before it resets (about ${projection.percentAtReset}%)`}
        // Inside a payment row: inspecting the warning must not select it.
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        style={{
          appearance: "none",
          border: 0,
          background: "transparent",
          padding: 0,
          color: UI_COLORS.warning,
          cursor: "pointer",
          lineHeight: 1,
        }}
      >
        <Icon name="warning" />
      </button>
    </Tooltip>
  );
}

// Short names for the windows Claude reports, to fit one line on a phone.
function shortWindowName(name: string): string {
  return /5 hours/.test(name) ? "5-hour" : /week/i.test(name) ? "Week" : name;
}

function SubscriptionUsage({ row }: { row: ExternalCredentialInfo }) {
  const usage = claudeSubscriptionUsage(
    row.metadata?.[CLAUDE_USAGE_METADATA_KEY],
  );
  if (!usage)
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        No usage reported yet
      </Typography.Text>
    );
  return (
    <div style={{ fontSize: 12 }}>
      {usage.windows.map((window) => (
        <div
          key={window.name}
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span style={{ width: 48, flex: "0 0 auto" }}>
            {shortWindowName(window.name)}
          </span>
          <Progress
            percent={window.usedPercent}
            status="normal"
            showInfo={false}
            size="small"
            style={{ flex: "1 1 60px", margin: 0, minWidth: 40 }}
            aria-label={`${window.name}: ${window.usedPercent}% used`}
          />
          <span style={{ flex: "0 0 auto" }}>{window.usedPercent}%</span>
          <ClaudeUsageLimitWarning window={window} />
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, flex: "0 1 auto", whiteSpace: "nowrap" }}
          >
            {window.resetSinceObserved ? "reset " : "resets "}
            <TimeAgo date={window.resetsAt} />
          </Typography.Text>
        </div>
      ))}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Updated <TimeAgo date={usage.observedAt} />
      </Typography.Text>
    </div>
  );
}

/**
 * Every Claude payment option as one row, each subscription with its last
 * reported usage, so the choice can be made (and usage seen) on a phone,
 * where the footer's hover popover cannot open.
 */
export function ClaudeCredentialList({
  credentials,
  value,
  loaded,
  disabled,
  onChange,
}: {
  credentials: ExternalCredentialInfo[];
  // "account-subscription:<id>", "account-api-key:<id>" or "project-secret".
  value: string;
  loaded: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const options = newAgentClaudeCredentialOptions(credentials);
  const known = options.some((option) => option.value === value);
  const byId = new Map(credentials.map((row) => [row.id, row]));
  const hasSubscription = options.some((option) =>
    option.value.startsWith("account-subscription:"),
  );
  return (
    <div>
      <Radio.Group
        aria-label="Claude credential"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        style={{ display: "flex", flexDirection: "column", gap: 6 }}
      >
        {options.map((option) => {
          const id = option.value.slice(option.value.indexOf(":") + 1);
          const row = byId.get(id);
          const subscription =
            row?.kind === CLAUDE_SUBSCRIPTION_KIND &&
            option.value.startsWith("account-subscription:");
          const selected = option.value === value;
          return (
            <Radio
              key={option.value}
              value={option.value}
              style={{
                alignItems: "flex-start",
                margin: 0,
                padding: "6px 8px",
                borderRadius: 6,
                border: `1px solid ${selected ? UI_COLORS.info : UI_COLORS.border}`,
                background: selected ? UI_COLORS.infoBg : undefined,
                width: "100%",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div>
                  <span style={{ fontWeight: selected ? 600 : undefined }}>
                    {option.label}
                  </span>
                  {selected && (
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, marginLeft: 6 }}
                    >
                      (used by this agent)
                    </Typography.Text>
                  )}
                </div>
                {subscription && row ? (
                  <SubscriptionUsage row={row} />
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {option.value === "project-secret"
                      ? "Billed to the owner of the project's ANTHROPIC_API_KEY"
                      : "Anthropic bills API usage to the key owner"}
                  </Typography.Text>
                )}
              </div>
            </Radio>
          );
        })}
        {!known && (
          <Radio value={value} style={{ margin: 0, padding: "6px 8px" }}>
            {loaded ? "Selected connection unavailable" : "Loading..."}
          </Radio>
        )}
      </Radio.Group>
      {hasSubscription && (
        <Typography.Paragraph
          type="secondary"
          style={{ fontSize: 12, margin: "6px 0 0" }}
        >
          Usage is what Claude last reported during a CoCalc turn on each
          subscription, by any of your agents. It may be out of date, and use
          elsewhere (claude.ai or other apps) since then is not included.{" "}
          <a
            href="https://claude.ai/settings/usage"
            target="_blank"
            rel="noopener noreferrer"
          >
            View usage on Claude
          </a>
        </Typography.Paragraph>
      )}
    </div>
  );
}
