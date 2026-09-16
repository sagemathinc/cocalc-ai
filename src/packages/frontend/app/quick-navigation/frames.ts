/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { IntlShape } from "react-intl";
import type { EditorSpec } from "@cocalc/frontend/frame-editors/frame-tree/types";
import { isIntlMessage } from "@cocalc/frontend/i18n";
import type { Frame, Layout } from "./model";

// Used when the editor module (and its spec) has not been loaded yet.
function fallbackLabel(type: string): string {
  if (type === "cm") return "Source";
  const words = type.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function frameLayout(
  tree: any,
  spec: EditorSpec | undefined,
  intl: IntlShape,
): { layout?: Layout; frames: Frame[] } {
  const frames: Frame[] = [];
  function visit(node: any): Layout | undefined {
    if (!node) return;
    const value = node.toJS?.() ?? node;
    const children =
      value.children ?? [value.first, value.second].filter(Boolean);
    if (children.length)
      return {
        direction: value.direction === "col" ? "col" : "row",
        tabs: value.type === "tabs",
        sizes: value.sizes ?? [value.pos ?? 0.5, 1 - (value.pos ?? 0.5)],
        children: children.map(visit).filter(Boolean) as Layout[],
      };
    if (
      !value.id ||
      !value.type ||
      value.type === "node" ||
      value.type === "tabs"
    )
      return;
    const text = (message: unknown): string | undefined =>
      isIntlMessage(message)
        ? intl.formatMessage(message)
        : typeof message === "string"
          ? message
          : undefined;
    const description = spec?.[value.type];
    const label =
      text(description?.name) ??
      text(description?.short) ??
      fallbackLabel(value.type);
    const frame: Frame = {
      id: value.id,
      type: value.type,
      path: value.path,
      label,
      short: text(description?.short) ?? label,
    };
    frames.push(frame);
    return { frame };
  }
  const layout = visit(tree);
  return { layout, frames };
}
