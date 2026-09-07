/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";

import { Icon } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const DROPDOWN_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "40px",
  width: "100%",
  zIndex: 120,
  background: UI_COLORS.elevated,
  border: `1px solid ${UI_COLORS.border}`,
  borderRadius: "6px",
  boxShadow: `0 8px 16px ${UI_COLORS.shadow}`,
  maxHeight: "30vh",
  overflowY: "auto",
};

interface Props {
  history: string[];
  historyIndex: number;
  setHistoryIndex: (idx: number) => void;
  onSelect: (idx: number) => void;
  style?: React.CSSProperties;
}

export const SearchHistoryDropdown: React.FC<Props> = React.memo(
  ({ history, historyIndex, setHistoryIndex, onSelect, style }) => {
    if (history.length === 0) return null;

    return (
      <div style={{ ...DROPDOWN_STYLE, ...style }}>
        {history.map((item, idx) => (
          <div
            key={`${idx}-${item}`}
            ref={
              idx === historyIndex
                ? (el) => el?.scrollIntoView({ block: "nearest" })
                : undefined
            }
            style={{
              alignItems: "center",
              background:
                idx === historyIndex ? UI_COLORS.selected : UI_COLORS.elevated,
              color: UI_COLORS.text,
              cursor: "pointer",
              display: "flex",
              gap: "8px",
              overflow: "hidden",
              padding: "6px 10px",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setHistoryIndex(idx)}
            onClick={() => {
              setHistoryIndex(idx);
              onSelect(idx);
            }}
          >
            <Icon name="history" />
            <span>{item}</span>
          </div>
        ))}
      </div>
    );
  },
);
