/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createContext, useContext, type ReactNode } from "react";
import { tab_to_path } from "@cocalc/util/misc";

export function chatIsForeground(
  path: string,
  activeProjectTab: string | undefined,
  agentWorkspace = false,
  visible = true,
) {
  return agentWorkspace
    ? visible
    : tab_to_path(activeProjectTab ?? "") === path;
}

export interface ChatEmbeddingOptions {
  agentWorkspace?: boolean;
  onSearchAll?: () => void;
  selectedNetworkId?: string;
  disableConversationFocus?: boolean;
  hideSingleFrameToolbar?: boolean;
  hideTopControls?: boolean;
  hideCompactThreadHeader?: boolean;
  hideComposerIdentity?: boolean;
  openFilesInWorkbench?: boolean;
  sidebarHiddenByDefault?: boolean;
  sidebarPreferenceKey?: string;
}

const Context = createContext<ChatEmbeddingOptions | undefined>(undefined);

export function ChatEmbeddingOptionsProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ChatEmbeddingOptions;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useChatEmbeddingOptions(): ChatEmbeddingOptions {
  return useContext(Context) ?? {};
}

export function readEmbeddedSidebarHidden({
  sidebarHiddenByDefault = false,
  sidebarPreferenceKey,
}: ChatEmbeddingOptions): boolean {
  if (!sidebarPreferenceKey || typeof localStorage === "undefined") {
    return sidebarHiddenByDefault;
  }
  try {
    const value = localStorage.getItem(sidebarPreferenceKey);
    return value == null ? sidebarHiddenByDefault : value === "true";
  } catch {
    return sidebarHiddenByDefault;
  }
}

export function writeEmbeddedSidebarHidden(
  sidebarPreferenceKey: string,
  hidden: boolean,
): void {
  try {
    localStorage.setItem(sidebarPreferenceKey, `${hidden}`);
  } catch {
    // Local storage is a preference only.
  }
}
