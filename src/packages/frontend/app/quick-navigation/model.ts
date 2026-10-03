/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { SettingsPageType } from "@cocalc/util/types/settings";
import type { FixedTab } from "@cocalc/frontend/project/page/fixed-tab-ids";

export interface Frame {
  id: string;
  // Descriptive name, used in hints ("Enter opens “Source”").
  label: string;
  // Compact name for the preview cells; falls back to the label.
  short?: string;
  type: string;
  path?: string;
}
export interface Layout {
  frame?: Frame;
  direction?: "row" | "col";
  tabs?: boolean;
  sizes?: number[];
  children?: Layout[];
}
export interface Editor {
  projectId: string;
  path: string;
  frames: Frame[];
  layout?: Layout;
  activeId?: string;
}
export type Destination =
  | { kind: "project"; projectId: string }
  | {
      kind: "file";
      projectId: string;
      path: string;
      frameId?: string;
      // Open (or focus) the side chat of the file instead of a layout frame.
      chat?: boolean;
    }
  | { kind: "project-page"; projectId: string; page: FixedTab }
  | { kind: "settings"; page: SettingsPageType }
  | { kind: "docs"; projectId?: string }
  | { kind: "agent"; agentId: string; agentName: string }
  // The workspace: Library artifacts, People conversations and people.
  | { kind: "artifact"; projectId: string; entryId: string }
  | { kind: "conversation"; projectId: string; conversationId: string }
  | { kind: "person"; accountId: string }
  | { kind: "action"; action: WorkspaceAction }
  // Pages of the top navigation bar.
  | { kind: "app-page"; page: AppPage };
export type WorkspaceAction =
  | "new-agent"
  | "new-project"
  | "new-artifact"
  | "new-conversation"
  | "toggle-sidebar";
export type AppPage =
  | "agents"
  | "all-agents"
  | "library"
  | "people"
  | "projects"
  | "hosts"
  | "admin"
  | "notifications";
export interface Candidate {
  id: string;
  title: string;
  detail: string;
  keywords?: string;
  priority: number;
  recent?: number;
  destination: Destination;
  editor?: Editor;
}
