/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { CloseOutlined } from "@ant-design/icons";
import { Button, Popconfirm } from "antd";
import { useState } from "react";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { version as currentVersion } from "@cocalc/util/smc-version";
import { COLORS } from "@cocalc/util/theme";
import { useProjectState } from "./project-state-hook";

const DISMISSED_KEY_PREFIX = "cocalc-dismissed-project-update";

function storageKey(project_id: string, targetVersion: number): string {
  return `${DISMISSED_KEY_PREFIX}:${project_id}:${targetVersion}`;
}

function isDismissed(project_id: string, targetVersion: number): boolean {
  try {
    return (
      window.localStorage?.getItem(storageKey(project_id, targetVersion)) ===
      "1"
    );
  } catch {
    return false;
  }
}

function dismiss(project_id: string, targetVersion: number): void {
  try {
    window.localStorage?.setItem(storageKey(project_id, targetVersion), "1");
  } catch {
    // Ignore storage failures; dismissal is only a UI preference.
  }
}

function numericVersion(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export default function ProjectVersionUpdate({
  project_id,
}: {
  project_id: string;
}) {
  const actions = useActions("projects");
  const projectStatus = useTypedRedux({ project_id }, "status");
  const projectState = useProjectState(project_id);
  const [closedTarget, setClosedTarget] = useState<number>();

  const runningVersion = numericVersion(projectStatus?.get?.("version"));
  const state = `${projectState?.get?.("state") ?? ""}`;
  const targetVersion = numericVersion(currentVersion);
  if (
    state !== "running" ||
    runningVersion == null ||
    targetVersion == null ||
    runningVersion >= targetVersion ||
    closedTarget === targetVersion ||
    isDismissed(project_id, targetVersion)
  ) {
    return null;
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        margin: "3px 6px 0 0",
        padding: "2px 4px 2px 8px",
        border: `1px solid ${COLORS.GRAY_L}`,
        borderRadius: 999,
        background: "white",
        color: COLORS.GRAY_D,
        fontSize: 12,
        whiteSpace: "nowrap",
        flex: "0 0 auto",
      }}
      title={`Project is running version ${runningVersion}; current version is ${targetVersion}.`}
    >
      <Icon name="refresh" style={{ color: COLORS.GRAY }} />
      <span>Project update</span>
      <Popconfirm
        placement="bottomRight"
        title="Restart project?"
        description="This restarts the project server so it uses the latest CoCalc project code."
        okText="Restart"
        cancelText="Not now"
        onConfirm={() => actions?.restart_project(project_id)}
      >
        <Button size="small">Restart</Button>
      </Popconfirm>
      <Button
        size="small"
        type="text"
        aria-label="Dismiss project update notice"
        icon={<CloseOutlined />}
        onClick={() => {
          dismiss(project_id, targetVersion);
          setClosedTarget(targetVersion);
        }}
      />
    </div>
  );
}
