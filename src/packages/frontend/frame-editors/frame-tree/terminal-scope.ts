/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Map } from "immutable";
import { get_leaf_ids_in_order, get_node } from "./tree-ops";

// This is a view of the persisted tree: hidden shells keep their sessions and
// layout positions, but must not remain keyboard or pointer targets.
export function terminalScopeView(
  tree: Map<string, any> | undefined,
  activeId?: string,
) {
  const active = tree && activeId ? get_node(tree, activeId) : undefined;
  const chats = tree
    ? get_leaf_ids_in_order(tree)
        .map((id) => get_node(tree, id))
        .filter((node) => node?.get("type") === "chatroom")
    : [];
  const chat =
    active?.get("type") === "chatroom"
      ? active
      : (chats.find(
          (node) =>
            active?.get("data-terminalScope") != null &&
            node?.get("data-selectedThreadKey") ===
              active.get("data-terminalScope"),
        ) ?? chats[0]);
  const scope = chat?.get("data-selectedThreadKey");
  function isVisible(node: Map<string, any> | undefined): boolean {
    if (!node) return false;
    if (!chat) return true;
    const type = node.get("type");
    if (type === "node" || type === "tabs") {
      const children = node.get("children");
      return children
        ? children.some(isVisible)
        : isVisible(node.get("first")) || isVisible(node.get("second"));
    }
    const terminalScope = node.get("data-terminalScope");
    return (
      !type?.startsWith("terminal") ||
      terminalScope == null ||
      terminalScope === scope
    );
  }
  function visibleId(id: string | undefined): string | undefined {
    if (!tree || !id) return id;
    const node = get_node(tree, id);
    return node && !isVisible(node) ? chat?.get("id") : id;
  }
  return { isVisible, visibleId };
}
