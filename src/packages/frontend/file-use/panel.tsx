/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Spin } from "antd";

import {
  React,
  useEffect,
  useRef,
  useState,
  useTypedRedux,
} from "../app-framework";
import FileUseViewer from "./viewer";
import { listRecentDocumentActivityBestEffort } from "./project-host";
import type { RecentDocumentActivityEntry } from "./types";

interface Props {
  onClose?: () => void;
  title?: React.ReactNode;
}

export function RecentDocumentActivityPanel({ onClose, title }: Props) {
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>("");
  const [rows, setRows] = useState<RecentDocumentActivityEntry[]>([]);
  const refreshIdRef = useRef(0);
  const account_id = useTypedRedux("account", "account_id");
  const user_map = useTypedRedux("users", "user_map");
  const project_map = useTypedRedux("projects", "project_map");

  const refresh = async (): Promise<void> => {
    const refreshId = refreshIdRef.current + 1;
    refreshIdRef.current = refreshId;
    try {
      setLoading(true);
      setLoadingMore(false);
      setError("");
      const finalRows = await listRecentDocumentActivityBestEffort({
        account_id,
        project_map,
        onRows: ({ rows: nextRows, complete }) => {
          if (refreshIdRef.current !== refreshId) {
            return;
          }
          setRows(nextRows);
          setLoading(false);
          setLoadingMore(!complete);
        },
      });
      if (refreshIdRef.current !== refreshId) {
        return;
      }
      setRows(finalRows);
    } catch (err) {
      if (refreshIdRef.current !== refreshId) {
        return;
      }
      setError(`${err ?? ""}`);
    } finally {
      if (refreshIdRef.current !== refreshId) {
        return;
      }
      setLoading(false);
      setLoadingMore(false);
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
      {loadingMore ? (
        <Alert
          type="info"
          showIcon
          message="Showing fast results first while slower projects continue loading."
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
