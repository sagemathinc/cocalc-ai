/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Tree operations — supports both legacy binary (first/second/pos) and
N-ary (children/sizes) representations.
*/

import { fromJS, List } from "immutable";
import { len, uuid } from "@cocalc/util/misc";
import { FrameDirection, ImmutableFrameTree, SetMap } from "./types";

/**
 * Migrate a binary (first/second/pos) tree to N-ary (children/sizes).
 * Idempotent — already-migrated trees pass through unchanged.
 */
export function migrateToNary(tree: ImmutableFrameTree): ImmutableFrameTree {
  if (tree == null) return tree;
  if (tree.has("children")) {
    const children = tree.get("children");
    const sizes = tree.get("sizes");
    const nextChildren: ImmutableFrameTree[] = [];
    const nextSizes: number[] = [];

    children.forEach((child: ImmutableFrameTree, i: number) => {
      const migrated = migrateToNary(child);
      if (migrated == null) return;
      nextChildren.push(migrated);
      if (sizes && i < sizes.size) {
        nextSizes.push(sizes.get(i));
      }
    });

    if (nextChildren.length === 1) {
      return nextChildren[0];
    }

    let node = tree;
    const nextChildrenList = List(nextChildren);
    if (!children.equals(nextChildrenList)) {
      node = node.set("children", nextChildrenList);
    }

    if (tree.get("type") === "node" && nextChildren.length >= 2) {
      let normalizedSizes: number[];
      if (nextSizes.length === nextChildren.length) {
        const total = nextSizes.reduce((sum, size) => sum + size, 0);
        normalizedSizes =
          total > 0
            ? nextSizes.map((size) => size / total)
            : Array(nextChildren.length).fill(1 / nextChildren.length);
      } else {
        normalizedSizes = Array(nextChildren.length).fill(
          1 / nextChildren.length,
        );
      }
      const nextSizesList = List(normalizedSizes);
      if (!sizes || !sizes.equals(nextSizesList)) {
        node = node.set("sizes", nextSizesList);
      }
    }

    if (tree.get("type") === "tabs" && nextChildren.length >= 2) {
      const activeTab = tree.get("activeTab") ?? 0;
      const clampedActiveTab = Math.max(
        0,
        Math.min(activeTab, nextChildren.length - 1),
      );
      if (activeTab !== clampedActiveTab) {
        node = node.set("activeTab", clampedActiveTab);
      }
    }

    return node;
  }

  const first = tree.get("first");
  const second = tree.get("second");
  if (!first && !second) return tree;
  if (!first || !second) {
    const child = first || second;
    return migrateToNary(child);
  }
  const pos = tree.get("pos") ?? 0.5;
  const migratedFirst = migrateToNary(first);
  const migratedSecond = migrateToNary(second);
  return tree
    .delete("first")
    .delete("second")
    .delete("pos")
    .set("children", fromJS([migratedFirst, migratedSecond]))
    .set("sizes", fromJS([pos, 1 - pos]));
}

export function set(tree: ImmutableFrameTree, obj: any): ImmutableFrameTree {
  const { id } = obj;
  if (id == null) {
    return tree;
  }
  if (len(obj) < 2) {
    return tree;
  }
  let done = false;
  const process = (node) => {
    if (node == null || done) {
      return node;
    }
    if (node.get("id") === id) {
      for (const k in obj) {
        const v = obj[k];
        if (k !== "id") {
          if (k === "pos" && v != null && node.has("children")) {
            const n = node.get("children").size;
            if (n === 2) {
              node = node.set("sizes", fromJS([v, 1 - v]));
            }
            continue;
          }
          if (v == null) {
            node = node.delete(k);
          } else {
            node = node.set(k, fromJS(v));
          }
        }
      }
      done = true;
      return node;
    }
    const children = node.get("children");
    if (children) {
      const newChildren = children.map((child: ImmutableFrameTree) =>
        process(child),
      );
      if (newChildren !== children) {
        node = node.set("children", newChildren);
      }
      return node;
    }
    for (const x of ["first", "second"]) {
      const sub0 = node.get(x);
      const sub1 = process(sub0);
      if (sub0 !== sub1) {
        node = node.set(x, sub1);
      }
    }
    return node;
  };
  return process(tree);
}

export function set_leafs(
  tree: ImmutableFrameTree,
  obj: object,
): ImmutableFrameTree {
  if (len(obj) < 1) {
    return tree;
  }
  const process = function (node) {
    if (node == null) {
      return node;
    }
    if (is_leaf(node)) {
      for (const k in obj) {
        const v = obj[k];
        node = node.set(k, fromJS(v));
      }
      return node;
    }
    const children = node.get("children");
    if (children) {
      const newChildren = children.map((child: ImmutableFrameTree) =>
        process(child),
      );
      if (newChildren !== children) {
        node = node.set("children", newChildren);
      }
      return node;
    }
    for (const x of ["first", "second"]) {
      const sub0 = node.get(x);
      const sub1 = process(sub0);
      if (sub0 !== sub1) {
        node = node.set(x, sub1);
      }
    }
    return node;
  };
  return process(tree);
}

function generate_id(ids?: Set<string>): string {
  let id = uuid().slice(0, 8);
  if (ids == null) return id;
  while (ids.has(id)) {
    id = uuid().slice(0, 8);
  }
  ids.add(id);
  return id;
}

export function assign_ids(tree: ImmutableFrameTree): ImmutableFrameTree {
  const process = function (node) {
    if (node == null) {
      return node;
    }
    if (!node.has("id") || typeof node.get("id") != "string") {
      node = node.set("id", generate_id());
    }
    const children = node.get("children");
    if (children) {
      const newChildren = children.map((child: ImmutableFrameTree) =>
        process(child),
      );
      if (newChildren !== children) {
        node = node.set("children", newChildren);
      }
      return node;
    }
    for (const x of ["first", "second"]) {
      const sub0 = node.get(x);
      const sub1 = process(sub0);
      if (sub0 !== sub1) {
        node = node.set(x, sub1);
      }
    }
    return node;
  };
  return process(tree);
}

function call_on_children(node: ImmutableFrameTree, f: Function): void {
  const children = node.get("children");
  if (children) {
    children.forEach((child: ImmutableFrameTree) => f(child));
    return;
  }
  if (node.has("first")) f(node.get("first"));
  if (node.has("second")) f(node.get("second"));
}

function walk(tree: ImmutableFrameTree, f: Function): void {
  let done = false;
  function process(node) {
    if (done) return;
    if (f(node) === false) {
      done = true;
      return;
    }
    call_on_children(node, process);
  }
  process(tree);
}

export function get_leaf_ids(tree: ImmutableFrameTree): SetMap {
  const ids = {};
  walk(tree, function (node) {
    if (is_leaf(node)) {
      ids[node.get("id")] = true;
    }
  });
  return ids;
}

export function get_leaf_ids_in_order(tree: ImmutableFrameTree): string[] {
  const ids: string[] = [];
  walk(tree, function (node) {
    if (is_leaf(node)) {
      ids.push(node.get("id"));
    }
  });
  return ids;
}

export function getAllIds(tree: ImmutableFrameTree): Set<string> {
  const ids = new Set<string>([]);
  walk(tree, function (node) {
    const id = node.get("id");
    if (id) {
      ids.add(id);
    }
  });
  return ids;
}

export function ensure_ids_are_unique(
  tree: ImmutableFrameTree,
): ImmutableFrameTree {
  const ids = {};
  let dupe = false;
  function process(node: ImmutableFrameTree): ImmutableFrameTree {
    if (node == null) {
      return node;
    }
    const id = node.get("id");
    if (ids[id] != null) {
      dupe = true;
      return node.set("id", generate_id());
    }
    const children = node.get("children");
    if (children) {
      const newChildren = children.map((child: ImmutableFrameTree) =>
        process(child),
      );
      if (newChildren !== children) {
        node = node.set("children", newChildren);
      }
      return node;
    }
    for (const x of ["first", "second"]) {
      const sub0 = node.get(x);
      const sub1 = process(sub0);
      if (sub0 !== sub1) {
        node = node.set(x, sub1);
      }
    }
    return node;
  }
  while (true) {
    dupe = false;
    tree = process(tree);
    if (!dupe) {
      return tree;
    }
  }
}

export function has_id(tree: ImmutableFrameTree, id: string): boolean {
  let has = false;
  function process(node: ImmutableFrameTree): void {
    if (has) {
      return;
    }
    if (node.get("id") === id) {
      has = true;
      return;
    }
    call_on_children(node, process);
  }
  process(tree);
  return has;
}

export function is_leaf(node: ImmutableFrameTree): boolean {
  return (
    node != null &&
    !node.get("first") &&
    !node.get("second") &&
    !node.get("children")
  );
}

export function get_node(
  tree: ImmutableFrameTree,
  id: string,
): ImmutableFrameTree | undefined {
  let the_node: ImmutableFrameTree | undefined;
  let done = false;
  function process(node: ImmutableFrameTree): void {
    if (done) {
      return;
    }
    if (node.get("id") === id) {
      the_node = node;
      done = true;
      return;
    }
    call_on_children(node, process);
  }
  process(tree);
  return the_node;
}

export function delete_node(
  tree: ImmutableFrameTree,
  id: string,
): ImmutableFrameTree {
  if (tree.get("id") === id) {
    return tree;
  }
  let done = false;
  function process(node: ImmutableFrameTree): ImmutableFrameTree {
    if (done) {
      return node;
    }
    const children = node.get("children");
    if (children) {
      const idx = children.findIndex(
        (c: ImmutableFrameTree) => c.get("id") === id,
      );
      if (idx >= 0) {
        done = true;
        const newChildren = children.delete(idx);
        const sizes = node.get("sizes");
        const newSizes = sizes ? sizes.delete(idx) : null;
        if (newChildren.size === 1) return newChildren.get(0);
        let result = node.set("children", newChildren);
        if (newSizes) {
          const total = newSizes.reduce((a: number, b: number) => a + b, 0);
          result = result.set(
            "sizes",
            newSizes.map((s: number) => s / total),
          );
        }
        if (node.get("type") === "tabs") {
          const activeTab = node.get("activeTab") ?? 0;
          if (idx < activeTab) {
            result = result.set("activeTab", activeTab - 1);
          } else if (idx === activeTab) {
            result = result.set(
              "activeTab",
              Math.min(activeTab, newChildren.size - 1),
            );
          }
        }
        return result;
      }
      const newCh = children.map((child: ImmutableFrameTree) => process(child));
      if (newCh !== children) return node.set("children", newCh);
      return node;
    }
    for (const x of ["first", "second"]) {
      if (!node.has(x)) continue;
      const t = node.get(x);
      if (t.get("id") == id) {
        done = true;
        if (x === "first") {
          return node.get("second");
        } else {
          return node.get("first");
        }
      }
      const t1 = process(t);
      if (t1 !== t) {
        node = node.set(x, t1);
      }
    }
    return node;
  }
  return process(tree);
}

function split_the_leaf(
  leaf: ImmutableFrameTree,
  direction: FrameDirection,
  type?: string,
  extra?: object,
  first?: boolean,
  ids?: Set<string>,
) {
  let leaf2;
  if (type == leaf.get("type") || type == null) {
    leaf2 = leaf.set("id", generate_id(ids));
  } else {
    leaf2 = fromJS({ id: generate_id(ids), type });
  }
  if (extra != null) {
    for (const key in extra) {
      leaf2 = leaf2.set(key, fromJS(extra[key]));
    }
  }
  const children = first ? [leaf2, leaf] : [leaf, leaf2];
  return fromJS({
    direction,
    id: generate_id(ids),
    type: "node",
    children,
    sizes: [0.5, 0.5],
  }) as ImmutableFrameTree;
}

export function split_leaf(
  tree: ImmutableFrameTree,
  id: string,
  direction: FrameDirection,
  type?: string,
  extra?: object,
  first?: boolean,
): ImmutableFrameTree {
  let done = false;
  const process = function (node) {
    if (node == null || done) {
      return node;
    }
    if (node.get("id") === id) {
      done = true;
      return split_the_leaf(
        node,
        direction,
        type,
        extra,
        first,
        getAllIds(tree),
      );
    }
    const children = node.get("children");
    if (children) {
      const newChildren = children.map((child: ImmutableFrameTree) =>
        process(child),
      );
      if (newChildren !== children) {
        node = node.set("children", newChildren);
      }
      return node;
    }
    for (const x of ["first", "second"]) {
      const t0 = node.get(x);
      const t1 = process(t0);
      if (t1 !== t0) {
        node = node.set(x, t1);
        break;
      }
    }
    return node;
  };
  return process(tree);
}

export function new_frame(
  tree: ImmutableFrameTree,
  type: string,
  direction: FrameDirection,
  first: boolean,
): ImmutableFrameTree {
  const ids = getAllIds(tree);
  const newLeaf = fromJS({ type, id: generate_id(ids) });
  const children = first ? [newLeaf, tree] : [tree, newLeaf];
  return fromJS({
    id: generate_id(ids),
    direction,
    type: "node",
    children,
    sizes: [0.5, 0.5],
  }) as ImmutableFrameTree;
}

export function is_leaf_id(tree: ImmutableFrameTree, id: string): boolean {
  const node = get_node(tree, id);
  if (node == null) return false;
  return is_leaf(node);
}

export function get_some_leaf_id(tree: ImmutableFrameTree): string {
  let done = false;
  let id: string | undefined = undefined;
  function process(node: ImmutableFrameTree): void {
    if (done || node == null) {
      return;
    }
    if (is_leaf(node)) {
      id = node.get("id");
      done = true;
      return;
    }
    const children = node.get("children");
    if (children) {
      children.forEach((child: ImmutableFrameTree) => {
        if (!done) process(child);
      });
      return;
    }
    for (const limb of ["first", "second"]) {
      if (!done && node.has(limb)) {
        process(node.get(limb));
      }
    }
  }
  process(tree);
  if (!id) {
    throw Error(
      "BUG -- get_some_leaf_id could not find any leaves! -- tree corrupt",
    );
  }
  return id;
}

export function get_parent_id(
  tree: ImmutableFrameTree,
  id: string,
): string | undefined {
  let done = false;
  let parent_id: string | undefined = undefined;
  function process(node: ImmutableFrameTree): void {
    if (done || node == null) {
      return;
    }
    if (is_leaf(node)) return;
    const children = node.get("children");
    if (children) {
      for (let i = 0; i < children.size; i++) {
        if (done) return;
        const child: ImmutableFrameTree = children.get(i);
        if (child.get("id") === id) {
          done = true;
          parent_id = node.get("id");
        } else {
          process(child);
        }
      }
      return;
    }
    for (const limb of ["first", "second"]) {
      if (!done && node.has(limb)) {
        const x: ImmutableFrameTree = node.get(limb);
        if (x.get("id") === id) {
          done = true;
          parent_id = node.get("id");
        } else {
          process(x);
        }
      }
    }
  }
  process(tree);
  return parent_id;
}

function replaceNodes(
  tree: ImmutableFrameTree,
  replacements: Map<string, ImmutableFrameTree>,
): ImmutableFrameTree {
  let remaining = replacements.size;
  function process(node: ImmutableFrameTree): ImmutableFrameTree {
    if (node == null || remaining === 0) return node;
    const id = node.get("id");
    const replacement = replacements.get(id);
    if (replacement !== undefined) {
      remaining--;
      return replacement;
    }
    const children = node.get("children");
    if (children) {
      const newChildren = children.map((child: ImmutableFrameTree) =>
        process(child),
      );
      if (newChildren !== children) return node.set("children", newChildren);
      return node;
    }
    for (const x of ["first", "second"]) {
      if (!node.has(x)) continue;
      const sub = node.get(x);
      const sub1 = process(sub);
      if (sub1 !== sub) node = node.set(x, sub1);
    }
    return node;
  }
  return process(tree);
}

function replaceNode(
  tree: ImmutableFrameTree,
  id: string,
  replacement: ImmutableFrameTree,
): ImmutableFrameTree {
  return replaceNodes(tree, new Map([[id, replacement]]));
}

export type DropPosition =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "center"
  | "tab";

export function swap_nodes(
  tree: ImmutableFrameTree,
  idA: string,
  idB: string,
): ImmutableFrameTree {
  if (idA === idB) return tree;
  const nodeA = get_node(tree, idA);
  const nodeB = get_node(tree, idB);
  if (!nodeA || !nodeB) return tree;
  return replaceNodes(
    tree,
    new Map([
      [idA, nodeB],
      [idB, nodeA],
    ]),
  );
}

export function move_node(
  tree: ImmutableFrameTree,
  sourceId: string,
  targetId: string,
  position: DropPosition,
): ImmutableFrameTree {
  if (sourceId === targetId) return tree;
  const sourceNode = get_node(tree, sourceId);
  if (!sourceNode) return tree;
  if (has_id(sourceNode, targetId)) return tree;
  if (position === "center") return swap_nodes(tree, sourceId, targetId);
  if (position === "tab") return merge_as_tabs(tree, sourceId, targetId);

  let result = delete_node(tree, sourceId);
  const direction: FrameDirection =
    position === "left" || position === "right" ? "col" : "row";
  const insertFirst = position === "left" || position === "top";

  const parentId = get_parent_id(result, targetId);
  if (parentId) {
    const parent = get_node(result, parentId);
    if (
      parent &&
      parent.get("direction") === direction &&
      parent.get("type") === "node"
    ) {
      const children = parent.get("children");
      if (children) {
        const targetIdx = children.findIndex(
          (c: ImmutableFrameTree) => c.get("id") === targetId,
        );
        if (targetIdx >= 0) {
          const insertIdx = insertFirst ? targetIdx : targetIdx + 1;
          const newChildren = children.insert(insertIdx, sourceNode);
          const oldSizes = parent.get("sizes");
          let newSizes;
          if (oldSizes && oldSizes.size === children.size) {
            const targetSize = oldSizes.get(targetIdx) / 2;
            newSizes = oldSizes
              .set(targetIdx, targetSize)
              .insert(insertIdx, targetSize);
          } else {
            const newSize = 1.0 / newChildren.size;
            newSizes = fromJS(Array(newChildren.size).fill(newSize));
          }
          const newParent = parent
            .set("children", newChildren)
            .set("sizes", newSizes);
          return replaceNode(result, parentId, newParent);
        }
      }
    }
  }

  let targetNode = get_node(result, targetId);
  let effectiveTargetId = targetId;
  if (!targetNode) {
    const origTarget = get_node(tree, targetId);
    if (origTarget?.get("children")) {
      const remainingChild = origTarget
        .get("children")
        .find((c: ImmutableFrameTree) => c.get("id") !== sourceId);
      if (remainingChild) {
        const remainingId = remainingChild.get("id") as string;
        targetNode = get_node(result, remainingId);
        if (targetNode) {
          effectiveTargetId = remainingId;
        }
      }
    }
    if (!targetNode) return result;

    const parentId2 = get_parent_id(result, effectiveTargetId);
    if (parentId2) {
      const parent2 = get_node(result, parentId2);
      if (
        parent2 &&
        parent2.get("direction") === direction &&
        parent2.get("type") === "node"
      ) {
        const children2 = parent2.get("children");
        if (children2) {
          const targetIdx2 = children2.findIndex(
            (c: ImmutableFrameTree) => c.get("id") === effectiveTargetId,
          );
          if (targetIdx2 >= 0) {
            const insertIdx2 = insertFirst ? targetIdx2 : targetIdx2 + 1;
            const newChildren2 = children2.insert(insertIdx2, sourceNode);
            const oldSizes2 = parent2.get("sizes");
            const targetSize = oldSizes2
              ? oldSizes2.get(targetIdx2) / 2
              : 1.0 / newChildren2.size;
            const newSizes2 = oldSizes2
              ? oldSizes2
                  .set(targetIdx2, targetSize)
                  .insert(insertIdx2, targetSize)
              : fromJS(Array(newChildren2.size).fill(1.0 / newChildren2.size));
            const newParent2 = parent2
              .set("children", newChildren2)
              .set("sizes", newSizes2);
            return replaceNode(result, parentId2, newParent2);
          }
        }
      }
    }
  }
  const ids = getAllIds(result);
  const childrenArr = insertFirst
    ? [sourceNode, targetNode]
    : [targetNode, sourceNode];
  const newSplit = fromJS({
    id: generate_id(ids),
    type: "node",
    direction,
    children: childrenArr,
    sizes: [0.5, 0.5],
  }) as ImmutableFrameTree;
  return replaceNode(result, effectiveTargetId, newSplit);
}

function merge_as_tabs(
  tree: ImmutableFrameTree,
  sourceId: string,
  targetId: string,
): ImmutableFrameTree {
  const sourceNode = get_node(tree, sourceId);
  if (!sourceNode) return tree;
  const result = delete_node(tree, sourceId);

  const targetParentId = get_parent_id(result, targetId);
  if (targetParentId) {
    const parent = get_node(result, targetParentId);
    if (parent && parent.get("type") === "tabs") {
      const children = parent.get("children");
      const newChildren = children.push(sourceNode);
      const newParent = parent
        .set("children", newChildren)
        .set("activeTab", newChildren.size - 1);
      return replaceNode(result, targetParentId, newParent);
    }
  }

  const targetNode = get_node(result, targetId);
  if (!targetNode) return result;
  const ids = getAllIds(result);
  const tabsNode = fromJS({
    id: generate_id(ids),
    type: "tabs",
    children: [targetNode, sourceNode],
    activeTab: 1,
  }) as ImmutableFrameTree;
  return replaceNode(result, targetId, tabsNode);
}

export function extract_from_tabs(
  tree: ImmutableFrameTree,
  sourceId: string,
  position: DropPosition,
): ImmutableFrameTree {
  const parentId = get_parent_id(tree, sourceId);
  if (!parentId) return tree;
  const parent = get_node(tree, parentId);
  if (!parent || parent.get("type") !== "tabs") return tree;
  const sourceNode = get_node(tree, sourceId);
  if (!sourceNode) return tree;

  const children = parent.get("children");
  const idx = children.findIndex(
    (c: ImmutableFrameTree) => c.get("id") === sourceId,
  );
  if (idx < 0) return tree;

  const newChildren = children.delete(idx);
  let remaining: ImmutableFrameTree;
  if (newChildren.size === 1) {
    remaining = newChildren.get(0);
  } else {
    remaining = parent.set("children", newChildren);
    const activeTab = parent.get("activeTab") ?? 0;
    if (idx < activeTab) {
      remaining = remaining.set("activeTab", activeTab - 1);
    } else if (idx === activeTab) {
      remaining = remaining.set(
        "activeTab",
        Math.min(activeTab, newChildren.size - 1),
      );
    }
  }

  const direction: FrameDirection =
    position === "left" || position === "right" ? "col" : "row";
  const insertFirst = position === "left" || position === "top";
  const ids = getAllIds(tree);
  const childrenArr = insertFirst
    ? [sourceNode, remaining]
    : [remaining, sourceNode];
  const newSplit = fromJS({
    id: generate_id(ids),
    type: "node",
    direction,
    children: childrenArr,
    sizes: [0.5, 0.5],
  }) as ImmutableFrameTree;

  return replaceNode(tree, parentId, newSplit);
}

export function add_tab(
  tree: ImmutableFrameTree,
  tabsId: string,
  type: string,
  path?: string,
): ImmutableFrameTree {
  const ids = getAllIds(tree);
  const newLeaf: any = { id: generate_id(ids), type };
  if (path) newLeaf.path = path;

  function process(node: ImmutableFrameTree): ImmutableFrameTree {
    if (node.get("id") === tabsId && node.get("type") === "tabs") {
      const children = node.get("children");
      return node
        .set("children", children.push(fromJS(newLeaf)))
        .set("activeTab", children.size);
    }
    const ch = node.get("children");
    if (ch) {
      const newCh = ch.map((c: ImmutableFrameTree) => process(c));
      if (newCh !== ch) return node.set("children", newCh);
    }
    return node;
  }
  return process(tree);
}

export function reorder_tab(
  tree: ImmutableFrameTree,
  tabsId: string,
  sourceFrameId: string,
  beforeFrameId: string | null,
): ImmutableFrameTree {
  function process(node: ImmutableFrameTree): ImmutableFrameTree {
    if (node.get("id") === tabsId && node.get("type") === "tabs") {
      let children = node.get("children");
      if (!children) return node;
      const srcIdx = children.findIndex(
        (c: ImmutableFrameTree) => c.get("id") === sourceFrameId,
      );
      if (srcIdx < 0) return node;
      const srcNode = children.get(srcIdx);
      children = children.delete(srcIdx);
      if (beforeFrameId == null) {
        children = children.push(srcNode);
      } else {
        const tgtIdx = children.findIndex(
          (c: ImmutableFrameTree) => c.get("id") === beforeFrameId,
        );
        if (tgtIdx < 0) {
          children = children.push(srcNode);
        } else {
          children = children.insert(tgtIdx, srcNode);
        }
      }
      const newIdx = children.findIndex(
        (c: ImmutableFrameTree) => c.get("id") === sourceFrameId,
      );
      return node.set("children", children).set("activeTab", newIdx);
    }
    const ch = node.get("children");
    if (ch) {
      const newCh = ch.map((c: ImmutableFrameTree) => process(c));
      if (newCh !== ch) return node.set("children", newCh);
    }
    return node;
  }
  return process(tree);
}

export function collapse_trivial(tree: ImmutableFrameTree): ImmutableFrameTree {
  if (tree == null) return tree;
  const children = tree.get("children");
  if (children) {
    const newChildren = children.map((child: ImmutableFrameTree) =>
      collapse_trivial(child),
    );
    const updated =
      newChildren !== children ? tree.set("children", newChildren) : tree;
    if (updated.get("children").size === 1) {
      return updated.get("children").get(0);
    }
    return updated;
  }
  for (const x of ["first", "second"]) {
    const sub0 = tree.get(x);
    if (sub0) {
      const sub1 = collapse_trivial(sub0);
      if (sub1 !== sub0) tree = tree.set(x, sub1);
    }
  }
  return tree;
}
