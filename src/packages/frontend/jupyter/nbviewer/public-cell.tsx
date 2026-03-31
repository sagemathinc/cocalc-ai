/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { KernelSpec } from "@cocalc/jupyter/ipynb/parse";
import PublicCellInput from "./public-cell-input";
import PublicCellOutput from "./public-cell-output";

interface Props {
  cell: { [key: string]: any };
  cmOptions: { [field: string]: any };
  kernelspec?: KernelSpec;
}

export default function PublicCell({ cell, cmOptions, kernelspec }: Props) {
  return (
    <div style={{ marginBottom: "10px" }}>
      <PublicCellInput cell={cell} cmOptions={cmOptions} />
      <PublicCellOutput cell={cell} kernelspec={kernelspec} />
    </div>
  );
}
