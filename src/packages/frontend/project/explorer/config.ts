/*
Store how a user has configured the view of a given directory.
*/

import { type DKV } from "@cocalc/conat/sync/dkv";
import { type SortField } from "@cocalc/frontend/project/listing/use-listing";
import { dirname } from "path";
import { redux } from "@cocalc/frontend/app-framework";
import { getSharedAccountDkv } from "@cocalc/frontend/conat/account-dkv";
import {
  getPersistAccountId,
  waitForPersistAccountId,
} from "./persist-account-id";

const NAME = "cocalc-explorer-config";

let kv: DKV | null = null;
let kvAccountId: string | null = null;

function closeKv() {
  kv = null;
  kvAccountId = null;
}

function invalidateIfAccountChanged() {
  const account_id = getPersistAccountId();
  if (
    kv != null &&
    kvAccountId != null &&
    account_id &&
    kvAccountId !== account_id
  ) {
    closeKv();
  }
}

async function init() {
  invalidateIfAccountChanged();
  const account_id = await waitForPersistAccountId();
  if (kv != null && kvAccountId === account_id) {
    return;
  }
  closeKv();
  kv = await getSharedAccountDkv({
    name: NAME,
    account_id,
  });
  kvAccountId = account_id;
}

interface Location {
  project_id: string;
  path?: string;
}

function key({ project_id, path = "/" }: Location) {
  return `${project_id}-${path}`;
}

// if field is given, goes up the path searching for something with field set
export function get(location: Location, field?: string) {
  invalidateIfAccountChanged();
  if (kv == null) {
    init();
    return undefined;
  }
  const value = kv.get(key(location));
  if (field && !value?.[field] && location.path) {
    let path = location.path;
    while (true) {
      const newPath = dirname(path);
      if (newPath.length >= path.length) {
        return undefined;
      }
      path = newPath;
      const value2 = get({ ...location, path });
      if (value2?.[field]) {
        return value2;
      }
    }
  }
  return value;
}

export async function set(
  opts: Location & {
    config: any;
  },
) {
  try {
    await init();
  } catch (err) {
    console.log("WARNING: issue initializing explorer config", err);
    return;
  }
  if (kv == null) {
    // this should never happen
    return;
  }
  const k = key(opts);
  kv.set(k, { ...kv.get(k), ...opts.config });
}

export function setSearch({
  search,
  pathOverride,
  ...location
}: Location & { search: any; pathOverride?: string }) {
  const targetPath = pathOverride ?? location.path;
  set({
    ...location,
    path: targetPath,
    // merge what was there with what's new
    config: {
      search: { ...get({ ...location, path: targetPath })?.search, ...search },
    },
  });
  const actions = redux.getProjectActions(location.project_id);
  actions.setState({ search_page: Math.random() });
  actions.search({ path: targetPath });
}

const FALLBACK_SEARCH = {
  subdirectories: true,
  case_sensitive: false,
  regexp: false,
  hidden_files: false,
  git_grep: true,
} as const;

export function getSearch(location) {
  invalidateIfAccountChanged();
  if (kv == null) {
    init();
    return FALLBACK_SEARCH;
  }
  const { search } = get(location, "search") ?? {};
  return { ...FALLBACK_SEARCH, ...search };
}

const FALLBACK_SORT = { column_name: "name", is_descending: false } as const;

export function getSort(location: Location): {
  column_name: SortField;
  is_descending: boolean;
} {
  invalidateIfAccountChanged();
  if (kv == null) {
    init();
    return FALLBACK_SORT;
  }
  const { sort } = get(location, "sort") ?? {};
  return sort ?? FALLBACK_SORT;
}

export async function getSortAsync(location: Location): Promise<{
  column_name: SortField;
  is_descending: boolean;
}> {
  try {
    await init();
  } catch {
    return FALLBACK_SORT;
  }
  return getSort(location);
}

export function setSort({
  column_name,
  ...location
}: Location & { column_name: string }) {
  const cur = getSort(location);
  let is_descending =
    cur == null || column_name != cur.column_name ? false : !cur?.is_descending;
  set({ ...location, config: { sort: { column_name, is_descending } } });

  // we ONLY trigger an update when the change is on this client, rather than
  // listening for changes on kv. The reason is because changing a sort order
  // on device causing it to change on another could be annoying...
  redux
    .getProjectActions(location.project_id)
    .setState({ active_file_sort: { column_name, is_descending } });
}
