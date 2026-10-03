/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { ComponentProps } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { useAppContext } from "./context";
import { CompactAgentsTopNav } from "./compact-agents-top-nav";

export function HomeWorkspaceNavigation(
  props: Omit<
    ComponentProps<typeof CompactAgentsTopNav>,
    "isLoggedIn" | "pageStyle"
  >,
) {
  const { pageStyle } = useAppContext();
  const accountId = useTypedRedux("account", "account_id");
  return (
    <CompactAgentsTopNav
      {...props}
      isLoggedIn={!!accountId}
      pageStyle={pageStyle}
    />
  );
}
