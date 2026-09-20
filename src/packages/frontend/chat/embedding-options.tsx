/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createContext, useContext, type ReactNode } from "react";

export interface ChatEmbeddingOptions {
  hideSingleFrameToolbar?: boolean;
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
