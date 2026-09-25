/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { Input } from "antd";

export function AgentSidebarFilter({
  render,
}: {
  render: (search: string, input: ReactNode) => ReactNode;
}) {
  const [search, setSearch] = useState("");
  return (
    <>
      {render(
        search,
        <Input
          allowClear
          aria-label="Filter agents or network tags"
          placeholder="Filter agents or tag:name"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />,
      )}
    </>
  );
}
