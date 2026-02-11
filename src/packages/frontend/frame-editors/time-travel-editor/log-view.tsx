import { List } from "immutable";
import { useState } from "react";
import { Button, Tooltip } from "antd";
import { TimeAgo } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import type { TimeTravelActions } from "./actions";

interface Props {
  actions: TimeTravelActions;
  source: "timetravel" | "git" | "snapshots" | "backups";
  versions: List<string | number>;
  currentVersion?: string | number;
  firstVersion: number;
  onSelectVersion: (
    version: string | number,
    opts?: { open?: boolean; shiftKey?: boolean; compareToPrevious?: boolean },
  ) => void;
}

interface Row {
  key: string;
  version: string | number;
  title: string;
  subtitle?: string;
  timeMs?: number;
}

export function LogView({
  actions,
  source,
  versions,
  currentVersion,
  firstVersion,
  onSelectVersion,
}: Props) {
  const [hoveredTitleKey, setHoveredTitleKey] = useState<string | null>(null);
  const rows = buildRows({ actions, source, versions, firstVersion });
  return (
    <div style={{ padding: "10px 15px", overflowY: "auto", height: "100%" }}>
      <div style={{ color: "#666", fontSize: "12px", marginBottom: "8px" }}>
        Click a title to compare with the previous version. Shift+click another
        row to compare with selected.
      </div>
      {rows.length === 0 ? (
        <div style={{ color: "#666" }}>No versions found.</div>
      ) : (
        rows.map((row) => {
          const selected = currentVersion === row.version;
          return (
            <div
              key={row.key}
              onClick={(e) =>
                onSelectVersion(row.version, { shiftKey: e.shiftKey })
              }
              style={{
                cursor: "default",
                padding: "8px 10px",
                borderRadius: "6px",
                marginBottom: "6px",
                border: selected ? "1px solid #1677ff" : "1px solid #eee",
                background: selected ? "#f0f6ff" : "white",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    display: "inline",
                    cursor: "pointer",
                    textDecoration:
                      hoveredTitleKey === row.key ? "underline" : "none",
                  }}
                  onMouseEnter={() => setHoveredTitleKey(row.key)}
                  onMouseLeave={() => setHoveredTitleKey(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectVersion(row.version, { compareToPrevious: true });
                  }}
                >
                  {row.title}
                </div>
                <Tooltip title="View file at this point">
                  <Button
                    type="link"
                    size="small"
                    style={{ padding: 0, height: "auto", whiteSpace: "nowrap" }}
                    icon={<Icon name="file" />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectVersion(row.version, { open: true });
                    }}
                  />
                </Tooltip>
              </div>
              <div style={{ color: "#666", fontSize: "12px" }}>
                {row.subtitle ?? ""}
                {row.timeMs != null && (
                  <>
                    {row.subtitle ? " · " : ""}
                    <TimeAgo date={new Date(row.timeMs)} time_ago_absolute />
                  </>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function buildRows({
  actions,
  source,
  versions,
  firstVersion,
}: {
  actions: TimeTravelActions;
  source: "timetravel" | "git" | "snapshots" | "backups";
  versions: List<string | number>;
  firstVersion: number;
}): Row[] {
  const rows: Row[] = [];
  const n = versions.size;
  for (let i = n - 1; i >= 0; i--) {
    const version = versions.get(i);
    if (version == null) continue;
    if (source === "git") {
      const commit = actions.gitCommit(version);
      rows.push({
        key: `git-${version}`,
        version,
        title: commit?.subject ?? `${version}`,
        subtitle: commit
          ? `${commit.shortHash} · ${commit.authorName}`
          : undefined,
        timeMs: commit?.timestampMs,
      });
      continue;
    }
    if (source === "snapshots") {
      const t = actions.snapshotWallTime(version);
      rows.push({
        key: `snap-${version}`,
        version,
        title: `Snapshot ${version}`,
        timeMs: t,
      });
      continue;
    }
    if (source === "backups") {
      const t = actions.backupWallTime(version);
      const id = `${version}`;
      rows.push({
        key: `backup-${id}`,
        version,
        title: `Backup ${id.slice(0, 8)}`,
        subtitle: id,
        timeMs: t,
      });
      continue;
    }
    const patchId = `${version}`;
    const t = actions.wallTime(patchId);
    const number = actions.versionNumber(patchId) ?? i + firstVersion;
    const user = actions.getUser(patchId);
    rows.push({
      key: `tt-${patchId}`,
      version,
      title: `Revision ${number}${toLetterCode(user)}`,
      timeMs: t,
    });
  }
  return rows;
}

function toLetterCode(user?: number): string {
  if (user == null) return "";
  return String.fromCharCode(97 + (user % 26));
}
