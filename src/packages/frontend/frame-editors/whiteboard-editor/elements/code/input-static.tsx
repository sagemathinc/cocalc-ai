/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { codemirrorMode } from "@cocalc/frontend/file-extensions";
import StaticCodeBlock from "@cocalc/frontend/components/static-code-block";
import { Element } from "../../types";

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
    <StaticCodeBlock
      value={element.str ?? ""}
      fontSize={element.data?.fontSize}
      info={modeName}
    />
  );
}
