/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map as iMap } from "immutable";
import { useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import { Button } from "antd";
import { Alert, Col, Row } from "@cocalc/frontend/antd-bootstrap";
import { SearchInput, Title, VisibleMDLG } from "@cocalc/frontend/components";
import { search_match, search_split } from "@cocalc/util/misc";
import { FileUseInfo } from "./info";
import { open_file_use_entry } from "./util";
import type { RecentDocumentActivityEntry } from "./types";

interface Props {
  rows: RecentDocumentActivityEntry[];
  user_map: iMap<string, any>;
  project_map: iMap<string, any>;
  account_id: string;
  onClose?: () => void;
  onRefresh?: () => void;
  title?: React.ReactNode;
}

export default function FileUseViewer({
  rows,
  user_map,
  project_map,
  account_id,
  onClose,
  onRefresh,
  title = "Recent document activity",
}: Props) {
  const [search, setSearch] = useState<string>("");
  const [cursor, setCursor] = useState<number>(0);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const searchableRows = useMemo(
    () =>
      rows.map((row) => {
        const parts = [
          row.path,
          project_map.getIn([row.project_id, "title"], ""),
        ];
        for (const recentAccountId of row.recent_account_ids ?? []) {
          parts.push(user_map.getIn([recentAccountId, "first_name"], ""));
          parts.push(user_map.getIn([recentAccountId, "last_name"], ""));
          if (recentAccountId === account_id) {
            parts.push("you");
          }
        }
        return {
          row,
          search: parts.join(" ").toLowerCase(),
        };
      }),
    [project_map, rows, user_map],
  );

  const visibleRows = useMemo(() => {
    if (!search) return searchableRows;
    const split = search_split(search.toLowerCase());
    return searchableRows.filter((entry) => search_match(entry.search, split));
  }, [search, searchableRows]);

  const hiddenCount = searchableRows.length - visibleRows.length;

  function moveCursor(nextCursor: number): void {
    if (visibleRows.length === 0) {
      setCursor(0);
      return;
    }
    const bounded = Math.max(0, Math.min(visibleRows.length - 1, nextCursor));
    setCursor(bounded);
    virtuosoRef.current?.scrollIntoView({ index: bounded });
  }

  function openSelected(): void {
    const selected = visibleRows[cursor]?.row;
    if (!selected) return;
    void open_file_use_entry(selected.project_id, selected.path, false);
  }

  return (
    <div className="smc-vfill smc-file-use-viewer">
      <VisibleMDLG>
        <div
          style={{
            margin: "15px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
          }}
        >
          <Title level={4} style={{ margin: 0, textAlign: "center" }}>
            {title}
          </Title>
          {onRefresh ? (
            <Button onClick={() => void onRefresh()} size="small">
              Refresh
            </Button>
          ) : null}
        </div>
      </VisibleMDLG>
      <Row style={{ marginBottom: "5px" }}>
        <Col sm={12}>
          <span className="smc-file-use-notifications-search">
            <SearchInput
              autoFocus
              placeholder="Search (use /re/ for regexp)..."
              default_value={search}
              on_change={(value) => {
                setSearch(value);
                setCursor(0);
              }}
              on_submit={openSelected}
              on_escape={(before) => {
                if (!before) onClose?.();
                setCursor(0);
              }}
              on_up={() => moveCursor(cursor - 1)}
              on_down={() => moveCursor(cursor + 1)}
            />
          </span>
        </Col>
      </Row>
      {hiddenCount > 0 ? (
        <Alert bsStyle="warning" style={{ marginBottom: "5px" }}>
          Hiding {hiddenCount} recent activity entries that do not match search
          for '{search}'.
        </Alert>
      ) : null}
      <Virtuoso
        ref={virtuosoRef}
        totalCount={visibleRows.length}
        itemContent={(index) => {
          const info = visibleRows[index]?.row;
          if (!info) return <div style={{ height: "1px" }} />;
          return (
            <FileUseInfo
              key={info.id}
              cursor={index === cursor}
              info={info}
              account_id={account_id}
              user_map={user_map}
            />
          );
        }}
      />
    </div>
  );
}
