/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Space } from "antd";
import type { MouseEvent, ReactNode } from "react";

import { getAlertName, type Alert } from "@cocalc/comm/project-status/types";

export type VisibleProjectStatusAlert = Exclude<Alert, { type: "cpu-cgroup" }>;

function alertToPlain(alert: any): Alert | undefined {
  const plain = typeof alert?.toJS === "function" ? alert.toJS() : alert;
  if (plain?.type == null) return;
  return plain as Alert;
}

function alertsToArray(projectStatus: any): any[] {
  const alerts = projectStatus?.get?.("alerts") ?? projectStatus?.alerts;
  if (alerts == null) return [];
  if (Array.isArray(alerts)) return alerts;
  if (typeof alerts.toJS === "function") {
    const plain = alerts.toJS();
    return Array.isArray(plain) ? plain : [];
  }
  if (typeof alerts.toArray === "function") return alerts.toArray();
  return [];
}

export function visibleProjectStatusAlerts(
  projectStatus: any,
): VisibleProjectStatusAlert[] {
  return alertsToArray(projectStatus).flatMap((value) => {
    const alert = alertToPlain(value);
    if (alert == null || alert.type === "cpu-cgroup") return [];
    return [alert as VisibleProjectStatusAlert];
  });
}

export function projectStatusAlertKey(
  alert: VisibleProjectStatusAlert,
): string {
  if (alert.type === "cpu-process") {
    return `${alert.type}:${alert.pids.join(",")}`;
  }
  if (alert.type === "component") {
    return `${alert.type}:${alert.names.join(",")}`;
  }
  return alert.type;
}

function describeAlert(alert: VisibleProjectStatusAlert): ReactNode {
  switch (alert.type) {
    case "cpu-process":
      return (
        <>
          One or more project processes have been using high CPU for several
          minutes. This warning is based on project process samples, not overall
          host load.
          {alert.pids.length > 0 ? (
            <>
              {" "}
              PIDs: <code>{alert.pids.join(", ")}</code>.
            </>
          ) : null}
        </>
      );
    case "disk":
      return (
        <>
          Project storage has very little free space. Review disk usage before
          writes or downloads fail.
        </>
      );
    case "memory":
      return (
        <>
          The project is close to its memory limit. Open the process list to see
          current memory usage.
        </>
      );
    case "component":
      return (
        <>
          A project service is reporting a problem:{" "}
          <code>{alert.names.join(", ")}</code>.
        </>
      );
  }
}

export function ProjectStatusAlertDetails({
  alerts,
  onOpenInfo,
}: {
  alerts: VisibleProjectStatusAlert[];
  onOpenInfo?: (event: MouseEvent<HTMLElement>) => void;
}) {
  if (alerts.length === 0) return null;
  return (
    <Space direction="vertical" size={8} style={{ maxWidth: 360 }}>
      {alerts.map((alert) => (
        <div key={projectStatusAlertKey(alert)}>
          <b>{getAlertName(alert.type)} warning</b>
          <div style={{ marginTop: 4 }}>{describeAlert(alert)}</div>
        </div>
      ))}
      {onOpenInfo != null ? (
        <Button size="small" onClick={onOpenInfo}>
          Open process list
        </Button>
      ) : null}
    </Space>
  );
}
