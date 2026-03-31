/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";
import type { KernelSpec } from "@cocalc/jupyter/ipynb/parse";
import PublicCell from "./public-cell";

interface Props {
  cellList: string[];
  cells: { [id: string]: object };
  cmOptions: { [field: string]: any };
  kernelspec?: KernelSpec;
  fontSize?: number;
  style?: CSSProperties;
}

export default function PublicCellList({
  cellList,
  cells,
  cmOptions,
  kernelspec,
  fontSize,
  style,
}: Props) {
  return (
    <div style={{ fontSize, ...style }}>
      {cellList.map((id) => {
        const cell = cells[id];
        if (cell == null) return null;
        return (
          <PublicCell
            key={id}
            cell={cell}
            cmOptions={cmOptions}
            kernelspec={kernelspec}
          />
        );
      })}
    </div>
  );
}
