/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  themeFromDraft,
  type ThemeEditorDraft,
} from "@cocalc/frontend/theme/types";
import type {
  RootfsImageEntry,
  RootfsImageTheme,
  RootfsImageVisibility,
} from "@cocalc/util/rootfs-images";

export type PublishDraft = {
  image: string;
  label: string;
  slug: string;
  description: string;
  family: string;
  version: string;
  channel: string;
  supersedes_image_id: string;
  theme: ThemeEditorDraft;
  visibility: RootfsImageVisibility;
  tags: string;
  official: boolean;
  prepull: boolean;
  hidden: boolean;
};

function rootfsThemeHasVisuals(theme: ThemeEditorDraft): boolean {
  return [theme.color, theme.accent_color, theme.icon, theme.image_blob].some(
    (value) => `${value ?? ""}`.trim().length > 0,
  );
}

export function rootfsThemeFromPublishDraft(
  publishDraft: PublishDraft,
): RootfsImageTheme | undefined {
  if (!rootfsThemeHasVisuals(publishDraft.theme)) {
    return undefined;
  }
  return themeFromDraft(publishDraft.theme);
}

export function buildRootfsPublishAssistCommand(opts: {
  projectId: string;
  publishMode: "copy" | "manage";
  publishCopyMode: "project" | "base";
  publishDraft: PublishDraft;
  publishSourceEntry?: RootfsImageEntry;
  switchPublishedProject: boolean;
}): string {
  const {
    projectId,
    publishMode,
    publishCopyMode,
    publishDraft,
    publishSourceEntry,
    switchPublishedProject,
  } = opts;
  const parts: string[] =
    publishMode === "copy" && publishCopyMode === "project"
      ? [
          "cocalc",
          "rootfs",
          "publish",
          "--project",
          shellQuoteCliArg(projectId),
          "--label",
          shellQuoteCliArg(publishDraft.label),
          "--wait",
        ]
      : [
          "cocalc",
          "rootfs",
          "save",
          "--image",
          shellQuoteCliArg(publishDraft.image),
          "--label",
          shellQuoteCliArg(publishDraft.label),
        ];
  if (publishMode === "manage" && publishSourceEntry?.can_manage) {
    pushCliOption(parts, "--image-id", publishSourceEntry.id);
  }
  pushCliOption(parts, "--description", publishDraft.description);
  pushCliOption(parts, "--slug", publishDraft.slug);
  pushCliOption(parts, "--family", publishDraft.family);
  pushCliOption(parts, "--image-version", publishDraft.version);
  pushCliOption(parts, "--channel", publishDraft.channel);
  pushCliOption(
    parts,
    "--supersedes-image-id",
    publishDraft.supersedes_image_id,
  );
  if (publishDraft.visibility) {
    pushCliOption(parts, "--visibility", publishDraft.visibility);
  }
  pushCliOption(parts, "--tags", publishDraft.tags);
  const theme = rootfsThemeFromPublishDraft(publishDraft);
  if (theme != null) {
    pushCliOption(parts, "--theme-json", JSON.stringify(theme));
  }
  if (publishDraft.official) parts.push("--official");
  if (publishDraft.prepull) parts.push("--prepull");
  if (publishDraft.hidden) parts.push("--hidden");
  if (
    publishMode === "copy" &&
    publishCopyMode === "project" &&
    switchPublishedProject
  ) {
    parts.push("--switch-project");
  }
  return parts.join(" ");
}

export function buildRootfsPublishAgentPrompt(opts: {
  projectId: string;
  command: string;
  publishMode: "copy" | "manage";
  publishCopyMode: "project" | "base";
  publishDraft: PublishDraft;
  publishSourceEntry?: RootfsImageEntry;
  switchPublishedProject: boolean;
}): string {
  const {
    projectId,
    command,
    publishMode,
    publishCopyMode,
    publishDraft,
    publishSourceEntry,
    switchPublishedProject,
  } = opts;
  const lines = [
    publishMode === "copy" && publishCopyMode === "project"
      ? `Publish the current RootFS of project ${projectId} as a managed CoCalc image.`
      : publishMode === "manage"
        ? `Update the existing RootFS catalog entry for project ${projectId}.`
        : `Save the current base image of project ${projectId} into the RootFS catalog.`,
    "",
    "Use the CoCalc CLI for this action:",
    "```sh",
    command,
    "```",
    "",
    publishMode === "copy" && publishCopyMode === "project"
      ? switchPublishedProject
        ? "Important: this publishes the current visible / software environment, then switches the project to the new image when publishing succeeds. It does not publish /root or /tmp."
        : "Important: this publishes the current visible / software environment. It does not publish /root or /tmp, and it does not switch the project to the new image."
      : publishMode === "manage"
        ? `Important: update the existing catalog entry${publishSourceEntry?.label ? ` (${publishSourceEntry.label})` : ""} instead of creating another copy.`
        : "Important: this only saves catalog metadata for the current base image. It does not create a new managed RootFS artifact from the live project state.",
    "",
    "Desired metadata:",
    `- label: ${publishDraft.label}`,
    `- description: ${publishDraft.description || "(empty)"}`,
    `- slug: ${publishDraft.slug || "(auto)"}`,
    `- family: ${publishDraft.family || "(none)"}`,
    `- version: ${publishDraft.version || "(none)"}`,
    `- channel: ${publishDraft.channel || "(none)"}`,
    `- supersedes_image_id: ${publishDraft.supersedes_image_id || "(none)"}`,
    `- visibility: ${publishDraft.visibility}`,
    `- tags: ${publishDraft.tags || "(none)"}`,
    `- theme: ${rootfsThemeFromPublishDraft(publishDraft) ? "customized" : "default"}`,
    `- official: ${publishDraft.official ? "yes" : "no"}`,
    `- prepull: ${publishDraft.prepull ? "yes" : "no"}`,
    `- hidden: ${publishDraft.hidden ? "yes" : "no"}`,
    ...(publishMode === "copy" && publishCopyMode === "project"
      ? [
          `- switch_project_after_publish: ${
            switchPublishedProject ? "yes" : "no"
          }`,
        ]
      : []),
    "",
    "After the action completes, report the resulting image name, image_id/release_id if available, and whether the action succeeded cleanly.",
  ];
  return lines.join("\n");
}

function pushCliOption(parts: string[], flag: string, value?: string) {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return;
  parts.push(flag, shellQuoteCliArg(trimmed));
}

function shellQuoteCliArg(value: string): string {
  return `'${`${value ?? ""}`.replace(/'/g, `'\\''`)}'`;
}
