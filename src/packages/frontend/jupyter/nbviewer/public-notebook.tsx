/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button } from "antd";
import { useMemo, useState, type CSSProperties } from "react";
import { useBottomScroller } from "@cocalc/frontend/app-framework/use-bottom-scroller";
import {
  type CoCalcJupyter,
  getCMOptions,
  getMode,
} from "@cocalc/jupyter/ipynb/parse";
import PublicCellList from "./public-cell-list";
import { PublicOutputModeContext } from "./public-cell-output";

interface Props {
  cocalcJupyter: CoCalcJupyter;
  project_id?: string;
  path?: string;
  fontSize?: number;
  style?: CSSProperties;
  cellListStyle?: CSSProperties;
  scrollBottom?: boolean;
}

export default function PublicNotebook({
  cocalcJupyter,
  fontSize,
  style,
  cellListStyle,
  scrollBottom,
}: Props) {
  const ref = useBottomScroller<HTMLDivElement>(scrollBottom, cocalcJupyter);
  let { cellList, cells, cmOptions, metadata, kernelspec } = cocalcJupyter;
  if (cmOptions == null) {
    cmOptions = getCMOptions(getMode({ metadata }));
  }

  const [interactive, setInteractive] = useState<boolean>(false);
  const mode = useMemo(() => ({ interactive }), [interactive]);
  const hasHtml = useMemo(() => hasHtmlOutput(cells), [cells]);

  return (
    <div ref={ref} style={style}>
      <div style={{ margin: "15px", textAlign: "right" }}>
        <b>Kernel:</b> {kernelspec.display_name}
      </div>
      {hasHtml && (
        <Alert
          style={{ margin: "0 15px 15px" }}
          type="info"
          showIcon
          title={
            interactive
              ? "Interactive output is on. Each HTML output runs in its own sandbox, so output that relies on scripts loaded by another cell may not work; open the notebook in a project for full fidelity."
              : "HTML output is shown without scripts. Interactive plots and widgets may be blank or show a static image."
          }
          action={
            <Button size="small" onClick={() => setInteractive(!interactive)}>
              {interactive
                ? "Hide interactive output"
                : "Show interactive output"}
            </Button>
          }
        />
      )}
      <PublicOutputModeContext.Provider value={mode}>
        <PublicCellList
          cellList={cellList}
          cells={cells}
          cmOptions={cmOptions}
          fontSize={fontSize}
          kernelspec={kernelspec}
          style={cellListStyle}
        />
      </PublicOutputModeContext.Provider>
    </div>
  );
}

function hasHtmlOutput(cells: { [id: string]: any }): boolean {
  for (const cell of Object.values(cells ?? {})) {
    for (const message of Object.values(cell?.output ?? {})) {
      const data = (message as any)?.data;
      if (data?.["text/html"] != null || data?.["iframe"] != null) {
        return true;
      }
    }
  }
  return false;
}
