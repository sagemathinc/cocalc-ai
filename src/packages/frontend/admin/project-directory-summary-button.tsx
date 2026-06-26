/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space, Typography } from "antd";
import { useCallback, useState } from "react";

import type { ProjectDirectorySummary } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { humanSize } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";

const { Text } = Typography;

function formatDirectoryEntry(
  entry: ProjectDirectorySummary["entries"][number],
): string {
  const size =
    typeof entry.size === "number" && Number.isFinite(entry.size)
      ? ` ${humanSize(entry.size)}`
      : "";
  const mtime = entry.mtime ? ` ${entry.mtime.slice(0, 19)}` : "";
  return `${entry.type.padEnd(9)} ${entry.path}${size}${mtime}`;
}

export function ProjectDirectorySummaryButton({
  project_id,
}: {
  project_id: string;
}) {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<ProjectDirectorySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result =
        await webapp_client.conat_client.hub.projects.getAdminProjectDirectorySummary(
          {
            project_id,
            path: "/home/user",
            max_depth: 2,
            limit: 80,
          },
        );
      setSummary(result);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, [project_id]);

  return (
    <div style={{ marginTop: "8px" }}>
      <Space wrap>
        <Button size="small" loading={loading} onClick={load}>
          Directory summary
        </Button>
        {summary ? (
          <Text type="secondary">
            {summary.entries.length} entries from {summary.root}
            {summary.truncated ? " (truncated)" : ""}
          </Text>
        ) : null}
      </Space>
      {error ? (
        <Alert
          style={{ marginTop: "8px" }}
          type="error"
          showIcon
          message="Unable to load directory summary"
          description={error}
        />
      ) : null}
      {summary ? (
        <pre
          style={{
            marginTop: "8px",
            maxHeight: "220px",
            overflow: "auto",
            background: COLORS.GRAY_LLL,
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: "6px",
            padding: "8px",
            whiteSpace: "pre",
          }}
        >
          {summary.entries.map(formatDirectoryEntry).join("\n") ||
            "(empty directory)"}
        </pre>
      ) : null}
    </div>
  );
}
