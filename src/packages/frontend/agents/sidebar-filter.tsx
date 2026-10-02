/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { Input } from "antd";

export interface AgentSidebarFilterState {
  // Every non-empty query must match: the search box's text, and the sticky
  // filter while the organize panel is open.
  queries: string[];
  // The filter input, shown in the organize panel.
  input: ReactNode;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
}

export function AgentSidebarFilter({
  query,
  render,
}: {
  // From the sidebar's search box.
  query: string;
  render: (filter: AgentSidebarFilterState) => ReactNode;
}) {
  const [filter, setFilter] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const queries = [query, panelOpen ? filter : ""].filter((q) => q.trim());
  return (
    <>
      {render({
        queries,
        panelOpen,
        setPanelOpen,
        input: (
          <Input
            allowClear
            aria-label="Filter agents or network tags"
            placeholder="Filter agents or tag:name"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        ),
      })}
    </>
  );
}
