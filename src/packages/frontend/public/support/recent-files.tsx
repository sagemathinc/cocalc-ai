/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { Alert, Spin, TreeSelect } from "antd";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  listRecentDocumentActivityBestEffort,
  parseIntervalToSeconds,
} from "@cocalc/frontend/file-use/project-host";
import { WORKSPACE_LABEL } from "@cocalc/util/i18n/terminology";

interface RecentFile {
  path: string;
  project_id: string;
  title: string;
}

interface Node {
  children?: Node[];
  title: ReactNode;
  value: string;
}

interface Props {
  disabled?: boolean;
  interval?: string;
  onChange?: (value: { project_id: string; path?: string }[]) => void;
}

export default function RecentFiles({ disabled, interval, onChange }: Props) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [treeData, setTreeData] = useState<Node[]>([]);
  const account_id = useTypedRedux("account", "account_id");
  const project_map = useTypedRedux("projects", "project_map");

  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        setLoading(true);
        setError("");
        const rows = await listRecentDocumentActivityBestEffort({
          account_id,
          project_map,
          max_age_s: parseIntervalToSeconds(interval),
        });
        if (canceled) {
          return;
        }

        const projects: Record<string, RecentFile[]> = {};
        for (const file of rows) {
          if (projects[file.project_id] == null) {
            projects[file.project_id] = [
              {
                project_id: file.project_id,
                path: file.path,
                title:
                  `${project_map?.getIn([file.project_id, "title"]) ?? ""}` ||
                  "Untitled",
              },
            ];
          } else {
            projects[file.project_id].push({
              project_id: file.project_id,
              path: file.path,
              title:
                `${project_map?.getIn([file.project_id, "title"]) ?? ""}` ||
                "Untitled",
            });
          }
        }

        const nextTreeData: Node[] = [];
        for (const project_id in projects) {
          const files = projects[project_id];
          if (files.length === 0) {
            continue;
          }
          const children: Node[] = [];
          nextTreeData.push({
            title: (
              <>
                {WORKSPACE_LABEL}: <b>{files[0].title}</b>
              </>
            ),
            value: files[0].project_id,
            children,
          });
          for (const file of files) {
            children.push({
              title: file.path,
              value: file.project_id + file.path,
            });
          }
        }
        setTreeData(nextTreeData);
      } catch (err) {
        if (!canceled) {
          setError(`${err}`);
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [account_id, interval, project_map]);

  return (
    <div>
      {error ? <Alert title={error} showIcon type="error" /> : null}
      {loading ? (
        <div style={{ padding: "8px 0" }}>
          <Spin size="small" /> Loading recent files...
        </div>
      ) : (
        <TreeSelect
          allowClear
          disabled={disabled}
          dropdownStyle={{ maxHeight: 400, overflow: "auto" }}
          multiple
          placeholder="Search for relevant files..."
          showSearch
          style={{ width: "100%" }}
          treeData={treeData}
          treeDefaultExpandAll
          onChange={(selected: string[]) => {
            if (!onChange) {
              return;
            }
            const value: { project_id: string; path?: string }[] = [];
            for (const item of selected) {
              const project_id = item.slice(0, 36);
              if (item.length <= 36) {
                value.push({ project_id });
              } else {
                value.push({ project_id, path: item.slice(36) });
              }
            }
            onChange(value);
          }}
        />
      )}
    </div>
  );
}
