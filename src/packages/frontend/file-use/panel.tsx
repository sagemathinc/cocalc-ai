/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Spin } from "antd";

import { React, useEffect, useState, useTypedRedux } from "../app-framework";
import FileUseViewer from "./viewer";
import { listRecentDocumentActivityBestEffort } from "./project-host";
import type { RecentDocumentActivityEntry } from "./types";

interface Props {
  onClose?: () => void;
  title?: React.ReactNode;
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
      setRows(
        await listRecentDocumentActivityBestEffort({
          account_id,
          project_map,
        }),
      );
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
