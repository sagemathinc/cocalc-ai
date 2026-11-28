/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// GFM tables ignore body cells beyond the header's column count, so
// "| a | b | extra" under a two-column header renders as "| a | b |".  Our
// editors write the parsed table back to markdown, so ignoring them means
// deleting them: e.g. a merge of concurrent edits that leaves text after a
// row's last pipe silently loses that text on the next rich-text save.
// Instead the excess cells are kept as part of the row's last cell, which
// is then written back as "| a | b \| extra |".

import type MarkdownIt from "markdown-it";

// Same as markdown-it's escapedSplit (rules_block/table): splits on unescaped
// pipes, turning "\|" into "|".
function escapedSplit(str: string): string[] {
  const result: string[] = [];
  let current = "";
  let lastPos = 0;
  let isEscaped = false;
  for (let pos = 0; pos < str.length; pos++) {
    const ch = str.charCodeAt(pos);
    if (ch === 0x7c /* | */) {
      if (!isEscaped) {
        result.push(current + str.substring(lastPos, pos));
        current = "";
        lastPos = pos + 1;
      } else {
        current += str.substring(lastPos, pos - 1);
        lastPos = pos;
      }
    }
    isEscaped = ch === 0x5c; /* \ */
  }
  result.push(current + str.substring(lastPos));
  return result;
}

// The row's cells as markdown-it splits them (outer pipes removed).
function rowCells(state, line: number): string[] {
  const text = state.src
    .slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
    .trim();
  const cells = escapedSplit(text);
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

export function tableExcessCellsPlugin(md: MarkdownIt): void {
  const rules = (md.block.ruler as any).__rules__ as {
    name: string;
    fn: Function;
    alt: string[];
  }[];
  const table = rules.find(({ name }) => name === "table");
  if (table == null) return;
  const original = table.fn;
  md.block.ruler.at(
    "table",
    (state, startLine, endLine, silent) => {
      const start = state.tokens.length;
      if (!original(state, startLine, endLine, silent)) return false;
      if (silent) return true;
      const tokens = state.tokens;
      let columnCount = 0;
      for (let i = start; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === "th_open") {
          columnCount += 1;
        } else if (token.type === "tr_open" && token.map != null) {
          const cells = rowCells(state, token.map[0]);
          if (columnCount === 0 || cells.length <= columnCount) continue;
          // The row's last cell: tr_open, then (td_open, inline, td_close)
          // per column.
          const last = tokens[i + 3 * columnCount - 1];
          if (last?.type !== "inline") continue;
          last.content = cells
            .slice(columnCount - 1)
            .map((cell) => cell.trim())
            .join(" | ");
        }
      }
      return true;
    },
    { alt: table.alt },
  );
}
