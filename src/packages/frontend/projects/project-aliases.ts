/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// My personal project aliases: /u/<me>/projects/<alias>/... Stored with my
// other personal state (People) on my home bay.

import { useSyncExternalStore } from "react";
import {
  myProjectAliases,
  onMyProjectAliasesChange,
  setMyProjectAliases,
} from "@cocalc/frontend/app/personal-url-identity";
import { lite } from "@cocalc/frontend/lite";
import { peopleApi } from "@cocalc/frontend/people/api";

export async function loadProjectAliases(): Promise<void> {
  if (lite) return;
  const rows = await peopleApi().listStates({ kind: "project" });
  setMyProjectAliases(
    rows
      .filter((row) => row.alias)
      .map((row) => ({ project_id: row.target_id, alias: row.alias! })),
  );
}

// Saving an empty alias removes it.
export async function setProjectAlias(
  project_id: string,
  alias: string,
): Promise<void> {
  await peopleApi().setState({
    kind: "project",
    target_id: project_id,
    project_id,
    patch: { alias },
  });
  await loadProjectAliases();
}

export function useProjectAliases(): ReadonlyMap<string, string> {
  return useSyncExternalStore(onMyProjectAliasesChange, myProjectAliases);
}
