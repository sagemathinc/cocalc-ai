/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import LRU from "lru-cache";
import PublicCellOutput from "@cocalc/frontend/jupyter/nbviewer/public-cell-output";
import { Element } from "../../types";
import Input from "./input-static";
import getStyle from "./style";

export default function Code({ element }: { element: Element }) {
  const { hideInput, hideOutput } = element.data ?? {};

  return (
    <div style={getStyle(element)}>
      {!hideInput && <Input element={element} />}
      {!hideOutput && element.data?.output && (
        <PublicCellOutput
          cell={{ id: element.id, output: element.data?.output }}
        />
      )}
    </div>
  );
}

// For more about this, see the comment in output.tsx.
export const moreOutput = new LRU<string, any>({ max: 50 });
