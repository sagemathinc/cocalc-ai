/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Spin } from "antd";

import { React, useEffect, useState, useTypedRedux } from "../app-framework";
import { listRecent as listProjectRecentDocumentActivity } from "@cocalc/conat/project/document-activity";
import FileUseViewer from "./viewer";
import { webapp_client } from "../webapp-client";
import type { RecentDocumentActivityEntry } from "./types";

interface Props {
  onClose?: () => void;
  title?: React.ReactNode;
}

const MAX_PROJECTS = 50;
const MAX_ROWS_PER_PROJECT = 25;
const MAX_ROWS_TOTAL = 250;

function makeId(project_id: string, path: string): string {
  return `${project_id}\u0000${path}`;
}

export function RecentDocumentActivityPanel({ onClose, title }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [rows, setRows] = useState<RecentDocumentActivityEntry[]>([]);
  const account_id = useTypedRedux("account", "account_id");
  const user_map = useTypedRedux("users", "user_map");
  const project_map = useTypedRedux("projects", "project_map");

  const refresh = async (): Promise<void> => {
    try {
      setLoading(true);
      setError("");
      const requester_account_id = `${account_id ?? ""}`.trim();
      if (!requester_account_id || !project_map) {
        setRows([]);
        return;
      }
      const candidateProjectIds = project_map
        .keySeq()
        .toArray()
        .sort((left, right) => {
          const a = Number(project_map.getIn([left, "last_edited"]) ?? 0);
          const b = Number(project_map.getIn([right, "last_edited"]) ?? 0);
          if (b !== a) {
            return b - a;
          }
          return `${left}`.localeCompare(`${right}`);
        })
        .slice(0, MAX_PROJECTS);
      const settled = await Promise.allSettled(
        candidateProjectIds.map(async (project_id) => {
          return await listProjectRecentDocumentActivity({
            client: webapp_client.conat_client.conat(),
            account_id: requester_account_id,
            project_id,
            limit: MAX_ROWS_PER_PROJECT,
            timeout: 4000,
          });
        }),
      );
      const merged: RecentDocumentActivityEntry[] = [];
      for (const result of settled) {
        if (result.status !== "fulfilled") {
          continue;
        }
        for (const row of result.value) {
          merged.push({
            id: makeId(row.project_id, row.path),
            project_id: row.project_id,
            path: row.path,
            last_accessed: row.last_accessed
              ? new Date(row.last_accessed)
              : null,
            recent_account_ids: row.recent_account_ids,
          });
        }
      }
      merged.sort((left, right) => {
        const a = left.last_accessed?.valueOf() ?? 0;
        const b = right.last_accessed?.valueOf() ?? 0;
        if (b !== a) {
          return b - a;
        }
        if (left.project_id !== right.project_id) {
          return left.project_id.localeCompare(right.project_id);
        }
        return left.path.localeCompare(right.path);
      });
      const deduped = new Map<string, RecentDocumentActivityEntry>();
      for (const row of merged) {
        deduped.set(row.id, row);
      }
      setRows(Array.from(deduped.values()).slice(0, MAX_ROWS_TOTAL));
    } catch (err) {
      setError(`${err ?? ""}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (!account_id || !user_map || !project_map) {
    return (
      <div style={{ padding: "24px", textAlign: "center" }}>
        <Spin />
      </div>
    );
  }

  return (
    <div
      className="smc-vfill"
      style={{
        minHeight: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          title="Recent document activity failed to load"
          description={error}
          style={{ marginBottom: "10px" }}
        />
      ) : null}
      {loading && rows.length === 0 ? (
        <div style={{ padding: "24px", textAlign: "center" }}>
          <Spin />
        </div>
      ) : (
        <FileUseViewer
          rows={rows}
          user_map={user_map}
          project_map={project_map}
          account_id={account_id}
          onClose={onClose}
          onRefresh={refresh}
          title={title}
        />
      )}
    </div>
  );
}
