/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type DocsAudience =
  | "agents"
  | "instructors"
  | "researchers"
  | "students"
  | "teams";

export type DocsEntryStatus = "draft" | "ready";
export type DocsProduct = "cocalc" | "plus";
export type DocsVisibility = "public" | "signed-in" | "admin";
export type DocsAccess = {
  includeAdmin?: boolean;
  includeSignedIn?: boolean;
  product?: DocsProduct;
};
export type DocsActionParameterType = "project" | "project-host";

export interface DocsActionParameter {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  type: DocsActionParameterType;
}

export type DocsActionId =
  | "account.membership.open"
  | "account.profile.open"
  | "account.ssh-keys.open"
  | "billing.payment-methods.open"
  | "billing.statements.open"
  | "admin.news.open"
  | "admin.news.create-system"
  | "admin.bay-ops.open"
  | "admin.membership-tiers.open"
  | "admin.managed-egress.open"
  | "admin.project-backup-shards.open"
  | "admin.registration-tokens.open"
  | "admin.rootfs.open"
  | "admin.site-settings.open"
  | "admin.software-licenses.open"
  | "admin.sso.open"
  | "admin.users.open"
  | "hosts.open"
  | "hosts.access.open"
  | "hosts.change-rules.open"
  | "hosts.lifecycle.open"
  | "hosts.move.open"
  | "hosts.reliability.open"
  | "hosts.runtime.open"
  | "hosts.scratch.open"
  | "hosts.storage.open"
  | "hosts.logs.open"
  | "hosts.spot-recovery.open"
  | "settings.environment.secrets"
  | "project.terminal.open"
  | "project.jupyter.create"
  | "settings.runtime.rootfs"
  | "settings.runtime.rootfs.publish"
  | "settings.people.collaborators"
  | "file.timetravel.open"
  | "project.codex.open"
  | "docs.browser.open"
  | "docs.actions.open"
  | "docs.automation.open"
  | "projects.list.open"
  | "projects.create.open"
  | "project.files.open"
  | "files.explorer.open"
  | "files.git.open"
  | "terminal.open"
  | "jupyter.open"
  | "files.markdown.open"
  | "files.slides.open"
  | "files.whiteboard.open"
  | "python.open"
  | "latex.open"
  | "r.markdown.open"
  | "projects.tasks.open"
  | "collaboration.chat.open";

export interface DocsAction {
  description: string;
  executable?: boolean;
  id: DocsActionId;
  label: string;
  parameters?: DocsActionParameter[];
}

export interface DocsActionSummary extends DocsAction {
  entryId: string;
  entrySlug: string;
  entryTitle: string;
}

export interface DocsChapter {
  category: string;
  startEntryId: string;
  summary: string;
  workflows: string[];
}

export interface DocsEntryImage {
  alt: string;
  presentation?: "hero" | "icon";
  src: string;
  thumbnailSrc?: string;
}

export interface DocsEntry {
  actions?: DocsAction[];
  audiences: DocsAudience[];
  body: string;
  category: string;
  id: string;
  image?: DocsEntryImage;
  lastReviewed: string;
  noActionReason?: string;
  searchKeywords?: string;
  slug: string;
  status: DocsEntryStatus;
  summary: string;
  title: string;
  visibility?: DocsVisibility;
}

export interface DocsSearchResult extends DocsEntry {
  score: number;
}
