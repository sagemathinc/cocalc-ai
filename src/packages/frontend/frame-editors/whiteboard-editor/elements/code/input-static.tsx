/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { codemirrorMode } from "@cocalc/frontend/file-extensions";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown-public";
import { Element } from "../../types";
import "@cocalc/frontend/components/static-code-block.css";

export default function InputStatic({
  element,
  mode,
}: {
  element: Element;
  mode?;
}) {
  // TODO: falling back to python for the mode below; will happen on share server or before things have fully loaded.
  // Instead, this should be stored cached in the file.
  const modeName =
    typeof mode === "string"
      ? mode
      : (mode?.name ?? codemirrorMode("py")?.name ?? "python");
  return (
    <StaticMarkdown
      value={toFencedCodeBlock(element.str ?? "", modeName)}
      style={
        element.data?.fontSize == null
          ? undefined
          : {
              ["--cocalc-static-code-font-size" as string]:
                element.data.fontSize,
            }
      }
      className={"cocalc-static-code-block"}
    />
  );
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
