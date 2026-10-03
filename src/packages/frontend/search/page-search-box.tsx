/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The search box at the top of a page, the same as the sidebar's: typing
// narrows this page's list, Enter opens the search results.

import type { InputRef } from "antd";
import { closeSearch, type SearchScope } from "./search-store";
import { setListQuery, submitSearch, useListQuery } from "./list-query";
import { SidebarSearchBox } from "./sidebar-search-box";

const LABELS: Record<SearchScope, string> = {
  agents: "Search agents",
  projects: "Search projects",
  artifacts: "Search artifacts",
  people: "Search people",
};

export function PageSearchBox({
  scope,
  style,
  inputRef,
}: {
  scope: SearchScope;
  style?: React.CSSProperties;
  inputRef?: React.RefObject<InputRef | null>;
}) {
  const query = useListQuery();
  return (
    <div style={{ flex: "0 1 320px", minWidth: 160, ...style }}>
      <SidebarSearchBox
        label={LABELS[scope]}
        value={query}
        onChange={setListQuery}
        onSubmit={(q) => submitSearch(q, scope)}
        onEscape={() => closeSearch({ restoreUrl: true })}
        shortcutHint={false}
        inputRef={inputRef}
      />
    </div>
  );
}
