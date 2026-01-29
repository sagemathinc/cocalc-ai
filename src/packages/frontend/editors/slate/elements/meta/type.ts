import { SlateElement } from "../register";
import { toCodeLines } from "../code-block/utils";

export interface Meta extends SlateElement {
  type: "meta";
  value: string;
  isVoid: false;
}

export function createMetaNode(value: string) {
  return {
    type: "meta" as "meta",
    value,
    isVoid: false as false,
    children: toCodeLines(value),
  };
}
