/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert } from "antd";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown-public";
import parse from "@cocalc/jupyter/ipynb/parse";
import PublicNotebook from "./public-notebook";

interface Props {
  content: string;
  project_id?: string;
  path?: string;
  fontSize?: number;
  style?: CSSProperties;
  cellListStyle?: CSSProperties;
  scrollBottom?: boolean;
}

export default function PublicNBViewer({ content, ...props }: Props) {
  const cocalcJupyter = useMemo(() => {
    try {
      return parse(content);
    } catch (error) {
      return error;
    }
  }, [content]);

  if (cocalcJupyter instanceof Error) {
    return (
      <div>
        <Alert
          title="Error Parsing Jupyter Notebook"
          description={`${cocalcJupyter}`}
          type="error"
        />
        <StaticMarkdown
          value={toFencedCodeBlock(content, "json")}
          className="cocalc-static-code-block cocalc-static-code-block--borderless"
        />
      </div>
    );
  }

  return <PublicNotebook cocalcJupyter={cocalcJupyter} {...props} />;
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
