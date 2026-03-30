/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import infoToMode from "@cocalc/frontend/editors/slate/elements/code-block/info-to-mode";
import "./static-code-block.css";

export function toFencedCodeBlock(content: string, language = ""): string {
  const text = `${content ?? ""}`;
  const fenceLen = Math.max(3, maxBacktickRun(text) + 1);
  const fence = "`".repeat(fenceLen);
  const info = language.trim();
  return `${fence}${info}\n${text}\n${fence}`;
}

export default function StaticCodeBlock({
  value,
  info,
  style,
  className,
  compact = false,
  borderless = false,
  noWrap = false,
  fontSize,
}: {
  value: string;
  info?: string;
  style?: CSSProperties;
  className?: string;
  compact?: boolean;
  borderless?: boolean;
  noWrap?: boolean;
  fontSize?: CSSProperties["fontSize"];
}) {
  const language = infoToMode(info, { value });
  return (
    <StaticMarkdown
      value={toFencedCodeBlock(value, language)}
      style={
        fontSize == null
          ? style
          : {
              ...style,
              ["--cocalc-static-code-font-size" as string]: fontSize,
            }
      }
      className={[
        "cocalc-static-code-block",
        compact ? "cocalc-static-code-block--compact" : undefined,
        borderless ? "cocalc-static-code-block--borderless" : undefined,
        noWrap ? "cocalc-static-code-block--nowrap" : undefined,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
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
