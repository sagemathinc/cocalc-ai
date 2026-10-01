/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { useRef } from "react";
import { redux } from "@cocalc/frontend/app-framework";
import { openLibrary } from "./library-navigation";
import { resolvePersonalUrl } from "@cocalc/frontend/personal-url-navigation";

interface Selection {
  accountId?: string;
  projectId?: string;
  entryId?: string;
  personalUrl?: string;
}

/** Sidebar return preserves selection; the detail's Back action still opens root. */
export function useLibraryNavigation({
  active,
  blocked,
  ...selection
}: Selection & { active: boolean; blocked: boolean }) {
  const retained = useRef<Selection>({ accountId: selection.accountId });
  if (retained.current.accountId !== selection.accountId)
    retained.current = { accountId: selection.accountId };
  if (active && !blocked) retained.current = selection;
  return () => {
    if (active && !blocked) return;
    const { projectId, entryId, personalUrl } = retained.current;
    if (personalUrl) {
      // Resolve in the original owner's namespace with the current viewer.
      void resolvePersonalUrl(personalUrl);
      void redux.getActions("page").set_active_tab("agents");
    } else {
      void openLibrary(projectId, entryId);
    }
  };
}
