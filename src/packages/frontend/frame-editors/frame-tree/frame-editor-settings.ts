/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Per-account frame editor settings, persisted in a Conat DKV.

Currently this stores the user's custom frame layout, scoped by file extension:
saving a layout while editing `foo.py` makes it the default for every `.py`
file that account opens.  The DKV is account-scoped, so it follows the user
across projects and browsers.

Keys have the form `custom-layout-{ext}` (e.g. `custom-layout-py`), or plain
`custom-layout` for files with no extension.
*/

import { getSharedAccountDkv } from "@cocalc/frontend/conat/account-dkv";
import {
  getPersistAccountId,
  waitForPersistAccountId,
} from "@cocalc/frontend/project/explorer/persist-account-id";
import { until } from "@cocalc/util/async-utils";
import { filename_extension } from "@cocalc/util/misc";

import type { FrameTree } from "./types";

const DKV_NAME = "frame-editor-settings";

// waitForPersistAccountId waits forever by default.  These settings are purely
// a convenience, so give up instead of hanging when there is no signed-in
// account (anonymous or public views).
const ACCOUNT_ID_TIMEOUT_MS = 15_000;

const CUSTOM_LAYOUT_PREFIX = "custom";
const LAYOUT_TYPE = "layout";

export function getFrameEditorSettingsName(
  type: string,
  path?: string,
): string {
  if (path) {
    const ext = filename_extension(path);
    if (ext) {
      return `${type}-${ext.toLowerCase()}`;
    }
  }
  return type;
}

export function getFrameEditorSettingsKey(
  prefix: string,
  editorName: string,
): string {
  return `${prefix}-${editorName}`;
}

function customLayoutKey(path: string): string {
  return getFrameEditorSettingsKey(
    CUSTOM_LAYOUT_PREFIX,
    getFrameEditorSettingsName(LAYOUT_TYPE, path),
  );
}

// NOTE: the DKV returned here is shared and cached process-wide by
// getSharedAccountDkv, which also closes it on sign-out.  Do NOT close it.
// Returns null when there is no signed-in account to scope settings to.
async function getSettingsDkv() {
  try {
    await until(() => getPersistAccountId() != null, {
      start: 50,
      max: 500,
      timeout: ACCOUNT_ID_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  const account_id = await waitForPersistAccountId();
  return await getSharedAccountDkv<unknown>({
    account_id,
    name: DKV_NAME,
  });
}

// Runtime type guard: validates that an unknown value read back from the DKV
// is a well-formed FrameTree (leaf, legacy binary node, n-ary node, or tabs
// node), so corrupted or outdated data can't crash the editor.
//
// Containers must hold at least one child. A childless container passes a
// naive shape check but contains no leaf, so applying it throws in
// get_some_leaf_id(): the automatic path would silently fall back while the
// menu still advertised the layout, leaving the account with a saved layout
// that can be neither applied nor -- absent any delete UI -- removed.
function isFrameTree(x: unknown): x is FrameTree {
  if (x == null || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  if (typeof t.type !== "string") return false;

  if (t.type === "node") {
    // legacy binary node
    if (t.first != null && t.second != null) {
      return isFrameTree(t.first) && isFrameTree(t.second);
    }
    // n-ary node
    if (Array.isArray(t.children)) {
      return t.children.length > 0 && t.children.every(isFrameTree);
    }
    return false;
  }

  if (t.type === "tabs") {
    return (
      Array.isArray(t.children) &&
      t.children.length > 0 &&
      t.children.every(isFrameTree)
    );
  }

  // leaf: just needs a type string, which was already checked above
  return true;
}

// Only these fields describe the structure of a layout.  Everything else in a
// frame tree node is transient and specific to one open file -- frame ids, the
// active id, per-frame font sizes, scroll positions, `data-` payloads -- and
// must not be persisted or restored into a different file.
const LAYOUT_FIELDS = [
  "type",
  "direction",
  "pos",
  "sizes",
  "activeTab",
  "first",
  "second",
  "children",
] as const;

function stripFrameTreeIds(tree: any): any {
  if (tree == null) return tree;
  const result: any = {};
  for (const key of LAYOUT_FIELDS) {
    if (!(key in tree)) continue;
    const val = tree[key];
    if (key === "children" && Array.isArray(val)) {
      result.children = val.map(stripFrameTreeIds);
    } else if (key === "first" && val != null && typeof val === "object") {
      result.first = stripFrameTreeIds(val);
    } else if (key === "second" && val != null && typeof val === "object") {
      result.second = stripFrameTreeIds(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// Save the given frame layout as this account's custom layout for the file
// type of `path`.
export async function saveCustomLayout(
  path: string,
  frameTreeJS: object,
): Promise<void> {
  const dkv = await getSettingsDkv();
  if (dkv == null) return;
  dkv.set(customLayoutKey(path), stripFrameTreeIds(frameTreeJS));
}

// Load this account's saved custom layout for the file type of `path`,
// or null if none was saved (or the stored value is unusable).
export async function loadCustomLayout(
  path: string,
): Promise<FrameTree | null> {
  const dkv = await getSettingsDkv();
  if (dkv == null) return null;
  const layout = dkv.get(customLayoutKey(path));
  return isFrameTree(layout) ? layout : null;
}

// Whether a custom layout exists for the file type of `path`.
export async function hasCustomLayout(path: string): Promise<boolean> {
  return (await loadCustomLayout(path)) != null;
}
