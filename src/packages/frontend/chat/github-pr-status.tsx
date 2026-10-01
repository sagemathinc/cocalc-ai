/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Compact GitHub-style status for a PR artifact: state badge, check status,
// how fresh the cached data is, and the reviewed revisions.

import { Tag, Tooltip, Typography } from "antd";
import type { ArtifactGitHubPR } from "@cocalc/chat";
import { artifactGitHubPRUrl } from "@cocalc/chat";
import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const STATE: Record<
  "open" | "draft" | "merged" | "closed",
  { label: string; color: string }
> = {
  open: { label: "Open", color: "green" },
  draft: { label: "Draft", color: "default" },
  merged: { label: "Merged", color: "purple" },
  closed: { label: "Closed", color: "red" },
};

const CHECKS: Record<
  ArtifactGitHubPR["checks"],
  { label: string; icon: IconName; color: string }
> = {
  passing: {
    label: "Checks passing",
    icon: "check-circle",
    color: UI_COLORS.success,
  },
  failing: {
    label: "Checks failing",
    icon: "close-circle-filled",
    color: UI_COLORS.danger,
  },
  pending: { label: "Checks running", icon: "clock", color: UI_COLORS.warning },
  unknown: {
    label: "No check status",
    icon: "question-circle",
    color: UI_COLORS.muted,
  },
};

export function prDisplayState(
  pr: Pick<ArtifactGitHubPR, "state" | "draft">,
): keyof typeof STATE {
  return pr.state === "open" && pr.draft ? "draft" : pr.state;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return new Date(time).toLocaleDateString();
}

function Sha({ sha, label }: { sha: string; label: string }) {
  return (
    <Typography.Text
      code
      copyable={{ text: sha, tooltips: [`Copy full ${label} SHA`, "Copied"] }}
      title={`${label} ${sha}`}
      style={{ fontSize: "0.9em" }}
    >
      {sha.slice(0, 7)}
    </Typography.Text>
  );
}

export function GitHubPRStatus({
  pr,
  historical = false,
  linkRepository = false,
  now,
}: {
  pr: ArtifactGitHubPR;
  historical?: boolean;
  // Link "owner/name #N" itself when there is no separate GitHub button.
  linkRepository?: boolean;
  now?: number;
}) {
  const state = STATE[prDisplayState(pr)];
  const checks = CHECKS[pr.checks] ?? CHECKS.unknown;
  const reference = `${pr.repository} #${pr.number}`;
  const exact = Number.isFinite(Date.parse(pr.fetched_at))
    ? new Date(pr.fetched_at).toLocaleString()
    : pr.fetched_at;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Tag color={state.color} style={{ margin: 0, fontWeight: 600 }}>
          {state.label}
        </Tag>
        {linkRepository ? (
          <a
            href={artifactGitHubPRUrl(pr)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {reference}
          </a>
        ) : (
          <span style={{ color: UI_COLORS.secondary }}>{reference}</span>
        )}
      </div>
      <div
        role="note"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          color: UI_COLORS.secondary,
          fontSize: "0.9em",
        }}
      >
        <span style={{ color: checks.color }}>
          <Icon name={checks.icon} /> {checks.label}
        </span>
        <span aria-hidden>·</span>
        <Tooltip
          title={`${historical ? "Published" : "Retrieved from GitHub"} ${exact}. Status may have changed since.`}
        >
          <span>
            {historical ? "Published" : "Updated"}{" "}
            {relativeTime(pr.fetched_at, now)}
          </span>
        </Tooltip>
        <span aria-hidden>·</span>
        <span>
          <Sha sha={pr.base_sha} label="base" /> →{" "}
          <Sha sha={pr.head_sha} label="head" />
        </span>
      </div>
    </div>
  );
}
