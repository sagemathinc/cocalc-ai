/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { useDebounce } from "../../hooks";
import { SearchInput } from "../../components";
import { ProjectActions } from "@cocalc/frontend/project_store";
import { EventRecordMap } from "./types";

interface Props {
  search?: string;
  actions: ProjectActions;
  selected?: EventRecordMap;
  increment_cursor: () => void;
  decrement_cursor: () => void;
  reset_cursor: () => void;
  onSubmit?: (value: string, info: any) => void;
}

export const LogSearch: React.FC<Props> = ({
  search,
  selected,
  actions,
  reset_cursor,
  increment_cursor,
  decrement_cursor,
  onSubmit,
}) => {
  const open_selected = React.useCallback(
    (_value, info: any): void => {
      if (onSubmit != null) {
        onSubmit(_value, info);
        return;
      }
      const e = selected?.get("event");
      if (e == undefined || typeof e === "string") {
        return;
      }

      switch (e.get("event")) {
        case "open":
          const target = e.get("filename");
          if (target != null) {
            actions.open_file({
              path: target,
              foreground: !info.ctrl_down,
            });
          }
          break;
        case "set":
          actions.set_active_tab("settings");
      }
    },
    [selected, actions, onSubmit],
  );

  const on_change = useDebounce(
    React.useCallback(
      (value: string): void => {
        reset_cursor();
        actions.setState({ search: value });
      },
      [reset_cursor, actions],
    ),
    150,
  );

  return (
    <SearchInput
      autoFocus={true}
      autoSelect={true}
      placeholder="Search (use /re/ for regexp)..."
      value={search}
      on_change={on_change}
      on_submit={open_selected}
      on_up={decrement_cursor}
      on_down={increment_cursor}
      on_escape={(): void => {
        actions.setState({ search: "" });
      }}
    />
  );
};
