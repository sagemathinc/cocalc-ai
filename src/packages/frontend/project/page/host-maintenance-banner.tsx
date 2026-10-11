/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Alert, Typography } from "antd";

import { React, useState } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import type { HostMaintenanceDisplay } from "@cocalc/frontend/projects/host-operational";

const { Text } = Typography;

function clock(date: Date, withDay: boolean): string {
  return date.toLocaleString([], {
    ...(withDay ? { weekday: "short", month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

function minutesText(minutes?: number): string {
  if (!minutes) return "a few minutes";
  return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

// Announces a scheduled maintenance window for the server that runs this
// project, and explains an outage while the window is in progress.
export function HostMaintenanceBanner({
  maintenance,
}: {
  maintenance: HostMaintenanceDisplay;
}) {
  const [dismissedKey, setDismissedKey] = useState<string>();
  const key = `${maintenance.state}:${maintenance.startsAt ?? ""}`;
  if (maintenance.state === "scheduled" && dismissedKey === key) {
    return null;
  }
  const now = new Date();
  const startsAt = maintenance.startsAt
    ? new Date(maintenance.startsAt)
    : undefined;
  const endsAt = maintenance.expectedEndAt
    ? new Date(maintenance.expectedEndAt)
    : undefined;
  const what =
    maintenance.kind === "relocation"
      ? "moved to a new machine"
      : "down for maintenance";

  let title: React.ReactNode;
  let body: React.ReactNode;
  if (maintenance.state === "scheduled") {
    title = (
      <>
        <Icon name="clock" /> Scheduled maintenance{" "}
        {startsAt ? (
          <>
            <TimeAgo click_to_toggle={false} date={startsAt} live /> (
            {clock(startsAt, !sameDay(startsAt, now))})
          </>
        ) : null}
      </>
    );
    body = (
      <>
        The server that runs this project will be {what} and unavailable for{" "}
        {minutesText(maintenance.expectedMinutes)}
        {startsAt ? ` starting at ${clock(startsAt, !sameDay(startsAt, now))}` : ""}
        . Running notebooks, terminals and programs will be stopped then;
        saved files are safe. Save your work before it starts.
      </>
    );
  } else {
    const late = maintenance.state === "failed" || maintenance.overdue;
    title = (
      <>
        <Icon name="wrench" /> This project's server is down for scheduled
        maintenance
      </>
    );
    body = (
      <>
        {startsAt ? (
          <>
            It started <TimeAgo click_to_toggle={false} date={startsAt} live />{" "}
            ({clock(startsAt, false)}).{" "}
          </>
        ) : null}
        {late ? (
          <Text strong>
            It is taking longer than expected; CoCalc staff have been
            notified.
          </Text>
        ) : endsAt ? (
          <Text strong>
            Expected back around {clock(endsAt, !sameDay(endsAt, now))}.
          </Text>
        ) : null}{" "}
        Your saved files are safe, and the project can be used again as soon
        as the server is back.
      </>
    );
  }
  return (
    <Alert
      banner
      showIcon={false}
      closable={maintenance.state === "scheduled"}
      onClose={() => setDismissedKey(key)}
      type={maintenance.state === "scheduled" ? "info" : "warning"}
      style={{ padding: "8px 16px" }}
      title={
        <div style={{ maxWidth: 840 }}>
          <div style={{ fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 13, marginTop: 2 }}>
            {body}
            {maintenance.message ? <> {maintenance.message}</> : null}
          </div>
        </div>
      }
    />
  );
}
