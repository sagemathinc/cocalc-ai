/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown-public";
import { InputPrompt } from "../prompt/input-nbviewer";

interface Props {
  cell: object;
  cmOptions: { [field: string]: any };
}

export default function PublicCellInput({ cell, cmOptions }: Props) {
  const value = cell["input"] ?? "";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
      }}
    >
      <InputPrompt exec_count={cell["exec_count"]} type={cell["cell_type"]} />
      {cell["cell_type"] == "markdown" ? (
        <div style={{ flex: 1 }}>
          <StaticMarkdown value={value} />
        </div>
      ) : (
        <div style={{ overflow: "hidden", flex: 1 }}>
          <StaticMarkdown
            value={toFencedCodeBlock(value, getCodeInfo(cmOptions))}
            style={{ padding: "10px" }}
          />
        </div>
      )}
    </div>
  );
}

function getCodeInfo(cmOptions: { [field: string]: any }): string {
  const mode = cmOptions?.mode;
  if (typeof mode === "string") return mode;
  if (typeof mode?.name === "string") return mode.name;
  return "";
}

function toFencedCodeBlock(content: string, language = ""): string {
  const text = `${content ?? ""}`;
  const fenceLen = Math.max(3, maxBacktickRun(text) + 1);
  const fence = "`".repeat(fenceLen);
  const info = language.trim();
  return `${fence}${info}\n${text}\n${fence}`;
}

function maxBacktickRun(text: string): number {
  let run = 0;
  let max = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > max) {
        max = run;
      }
    } else {
      run = 0;
    }
  }
  return max;
}
