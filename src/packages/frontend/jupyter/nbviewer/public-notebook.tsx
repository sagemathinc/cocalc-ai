/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";
import { useBottomScroller } from "@cocalc/frontend/app-framework/use-bottom-scroller";
import {
  type CoCalcJupyter,
  getCMOptions,
  getMode,
} from "@cocalc/jupyter/ipynb/parse";
import PublicCellList from "./public-cell-list";

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

  return (
    <div ref={ref} style={style}>
      <div style={{ margin: "15px", textAlign: "right" }}>
        <b>Kernel:</b> {kernelspec.display_name}
      </div>
      <PublicCellList
        cellList={cellList}
        cells={cells}
        cmOptions={cmOptions}
        fontSize={fontSize}
        kernelspec={kernelspec}
        style={cellListStyle}
      />
    </div>
  );
}
