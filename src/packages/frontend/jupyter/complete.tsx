/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Tag } from "antd";
import type { Map } from "immutable";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Tooltip } from "@cocalc/frontend/components";
import useNotebookFrameActions from "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/hook";
import { COLORS } from "@cocalc/util/theme";

// e.g., this is a subset of { JupyterActions } from "./browser-actions";
export interface Actions {
  select_complete: (
    id: string,
    item: string,
    complete?: Map<string, any>,
  ) => void;
  clear_complete: () => void;
  focus_complete?: () => void;
}

interface Props {
  actions: Actions;
  id: string;
  complete: Map<string, any>;
  code?: string;
  cursorIndex?: number;
  filterText?: string;
}

// WARNING: Complete closing when clicking outside the complete box
// is handled in cell-list on_click.  This is ugly code (since not localized),
// but seems to work well for now.  Could move.
export function Complete({
  actions,
  id,
  complete,
  code,
  cursorIndex,
  filterText,
}: Props) {
  const frameActions = useNotebookFrameActions();
  const menuRef = useRef<HTMLUListElement | null>(null);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);
  const anchorTop = complete.getIn(["offset", "top"], 0) as number;
  const anchorBottom = complete.getIn(
    ["offset", "bottom"],
    anchorTop,
  ) as number;
  const anchorLeft = complete.getIn(["offset", "left"], 0) as number;
  const [position, setPosition] = useState({
    top: anchorBottom,
    left: anchorLeft,
  });
  const originalCode = complete.get("code", "") as string;
  const cursorStart = complete.get("cursor_start", 0) as number;
  const originalCursorEnd = complete.get("cursor_end", cursorStart) as number;
  const currentCode = code ?? originalCode;
  const currentCursorIndex = cursorIndex ?? originalCursorEnd;
  const currentFilterText =
    filterText ?? currentCode.slice(cursorStart, currentCursorIndex);
  const allMatches = useMemo(
    () => (complete.get("matches")?.toArray?.() ?? []) as string[],
    [complete],
  );
  const matches = useMemo(
    () =>
      currentFilterText === ""
        ? allMatches
        : allMatches.filter((item) => item.startsWith(currentFilterText)),
    [allMatches, currentFilterText],
  );
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    return () => {
      // No matter what, when the complete dialog goes away, restore focus
      // and edit mode to the cell.
      frameActions.current?.set_mode("edit");
    };
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [complete, currentFilterText]);

  useEffect(() => {
    const selected = itemRefs.current[selectedIndex];
    selected?.scrollIntoView?.({ block: "nearest" });
  }, [matches, selectedIndex]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu == null) return;
    const margin = 8;
    const gap = 2;
    const rect = menu.getBoundingClientRect();
    const viewportHeight = document.documentElement.clientHeight;
    const viewportWidth = document.documentElement.clientWidth;
    const roomBelow = viewportHeight - anchorBottom - margin;
    const roomAbove = anchorTop - margin;
    const openAbove = rect.height > roomBelow && roomAbove > roomBelow;
    const top = openAbove
      ? Math.max(margin, anchorTop - rect.height - gap)
      : Math.min(anchorBottom + gap, viewportHeight - rect.height - margin);
    const left = Math.min(
      Math.max(margin, anchorLeft),
      Math.max(margin, viewportWidth - rect.width - margin),
    );
    setPosition({ top, left });
  }, [anchorBottom, anchorLeft, anchorTop, complete, matches.length]);

  const typeInfo = useMemo(() => {
    const types = complete?.getIn(["metadata", "_jupyter_types_experimental"]);
    if (types == null) {
      return {};
    }
    const typeInfo: { [text: string]: { type: string; signature: string } } =
      {};
    // @ts-ignore
    for (const info of types) {
      const text = info.get("text");
      if (typeInfo[text] == null) {
        typeInfo[text] = {
          type: info.get("type"),
          signature: info.get("signature"),
        };
      }
    }
    return typeInfo;
  }, [complete]);

  function select(item: string): void {
    // Save contents of editor to the store so that completion properly *places* the
    // completion in the correct place: see https://github.com/sagemathinc/cocalc/issues/3978
    frameActions.current?.save_input_editor(id);

    // Actually insert the completion:
    const currentComplete = complete
      .set("base", currentCode)
      .set("code", currentCode)
      .set("cursor_end", currentCursorIndex);
    actions.select_complete(id, item, currentComplete);
    setTimeout(() => actions.focus_complete?.(), 0);
  }

  itemRefs.current.length = matches.length;

  function renderItem(item: string, index: number) {
    const selected = index === selectedIndex;
    return (
      <li
        aria-selected={selected}
        key={item}
        ref={(node) => {
          itemRefs.current[index] = node;
        }}
        role="option"
        style={{ background: selected ? COLORS.BLUE_LLLL : undefined }}
        onMouseEnter={() => setSelectedIndex(index)}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          select(item);
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <a role="presentation" style={{ display: "flex", fontSize: "13px" }}>
          {item}
          {typeInfo[item]?.type ? (
            <Tooltip title={`${item}${typeInfo[item].signature}`}>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    float: "right",
                    marginLeft: "30px",
                    color: "#0000008a",
                    fontFamily: "monospace",
                  }}
                >
                  <Tag color={typeToColor[typeInfo[item].type]}>
                    {typeInfo[item].type}
                  </Tag>
                </div>
              </div>
            </Tooltip>
          ) : null}
        </a>
      </li>
    );
  }

  function moveSelection(index: number): void {
    const count = matches.length;
    if (count === 0) return;
    setSelectedIndex(((index % count) + count) % count);
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      switch (e.key) {
        case "Escape":
          consume();
          actions.clear_complete();
          return;
        case "ArrowDown":
          consume();
          moveSelection(selectedIndex + 1);
          return;
        case "ArrowUp":
          consume();
          moveSelection(selectedIndex - 1);
          return;
        case "Home":
          consume();
          moveSelection(0);
          return;
        case "End":
          consume();
          moveSelection(matches.length - 1);
          return;
        case "Enter":
        case "Tab": {
          consume();
          const item = matches[selectedIndex] ?? matches[0];
          if (item != null) {
            select(item);
          }
          return;
        }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [
    actions,
    complete,
    currentCode,
    currentCursorIndex,
    id,
    matches,
    selectedIndex,
  ]);

  function getStyle(): CSSProperties {
    return {
      cursor: "pointer",
      top: `${position.top}px`,
      left: `${position.left}px`,
      zIndex: 2000,
      width: 0,
      height: 0,
      position: "fixed",
    };
  }

  const menu = (
    <div className="dropdown open" style={getStyle()}>
      <ul
        ref={menuRef}
        aria-label="Code completions"
        className="dropdown-menu cocalc-complete"
        role="listbox"
        style={{
          maxHeight: "min(50vh, 24rem)",
          overflowY: "auto",
        }}
      >
        {matches.length > 0 ? (
          matches.map(renderItem)
        ) : (
          <li
            aria-disabled="true"
            aria-selected="false"
            role="option"
            style={{ padding: "3px 20px" }}
          >
            No matching completions
          </li>
        )}
      </ul>
    </div>
  );

  return createPortal(menu, document.body);
}

const typeToColor = {
  function: "blue",
  statement: "green",
  module: "cyan",
  class: "orange",
  instance: "magenta",
  "<unknown>": "red",
  path: "gold",
  keyword: "purple",
  magic: "geekblue",
  param: "volcano",
};
