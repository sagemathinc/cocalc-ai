/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { CloseOutlined } from "@ant-design/icons";
import { Button, Popconfirm } from "antd";
import { useEffect, useState } from "react";

import { useActions, useProjectMapField } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";
import { useProjectState } from "./project-state-hook";

const DISMISSED_KEY_PREFIX = "cocalc-dismissed-project-update";
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

interface LiveProjectStatus {
  state?: string;
  project_bundle_version?: string;
  tools_version?: string;
}

function storageKey(project_id: string, targetVersion: string): string {
  return `${DISMISSED_KEY_PREFIX}:${project_id}:${targetVersion}`;
}

function isDismissed(project_id: string, targetVersion: string): boolean {
  try {
    return (
      window.localStorage?.getItem(storageKey(project_id, targetVersion)) ===
      "1"
    );
  } catch {
    return false;
  }
}

function dismiss(project_id: string, targetVersion: string): void {
  try {
    window.localStorage?.setItem(storageKey(project_id, targetVersion), "1");
  } catch {
    // Ignore storage failures; dismissal is only a UI preference.
  }
}

function versionString(value: unknown): string | undefined {
  const s = `${value ?? ""}`.trim();
  return s || undefined;
}

export default function ProjectVersionUpdate({
  project_id,
}: {
  project_id: string;
}) {
  const actions = useActions("projects");
  const projectState = useProjectState(project_id);
  const host_id = useProjectMapField<string>(project_id, "host_id");
  const publicDirectoryShareProjection = !!useProjectMapField<boolean>(
    project_id,
    "public_directory_share_projection",
  );
  const hostInfo = useHostInfo(host_id);
  const [liveStatus, setLiveStatus] = useState<LiveProjectStatus>();
  const [closedTarget, setClosedTarget] = useState<string>();

  const state = `${liveStatus?.state ?? projectState?.get?.("state") ?? ""}`;
  const targetVersion = versionString(
    hostInfo?.get?.("project_bundle_version"),
  );
  const runningVersion =
    versionString(liveStatus?.project_bundle_version) ??
    versionString(projectState?.get?.("project_bundle_version"));

  useEffect(() => {
    if (publicDirectoryShareProjection) return;
    if (state !== "running") return;
    let closed = false;
    const refresh = async () => {
      try {
        if (host_id) {
          await actions?.ensure_host_info?.(host_id, true);
        }
        const status = await webapp_client.conat_client.hub.projects.status?.({
          project_id,
        });
        if (!closed) {
          setLiveStatus(status);
        }
      } catch {
        // Missing update metadata should not interrupt normal project use.
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), CHECK_INTERVAL_MS);
    return () => {
      closed = true;
      clearInterval(interval);
    };
  }, [actions, host_id, project_id, publicDirectoryShareProjection, state]);

  if (
    publicDirectoryShareProjection ||
    state !== "running" ||
    runningVersion == null ||
    targetVersion == null ||
    runningVersion === targetVersion ||
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
      title={`Project is running bundle ${runningVersion}; current host bundle is ${targetVersion}.`}
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
