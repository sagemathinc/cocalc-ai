/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { IconName } from "@cocalc/frontend/components/icon";
import type { Available } from "@cocalc/comm/project-configuration";
import { file_options } from "@cocalc/frontend/editor-tmp";
import { capitalize } from "@cocalc/util/misc";
import { NEW_FILETYPE_ICONS } from "./consts";

export type QuickCreateId = string;

export interface QuickCreateSpec {
  id: QuickCreateId;
  ext: string;
  label: string;
  icon: IconName;
}

export const QUICK_CREATE_CATALOG: QuickCreateSpec[] = [
  { id: "chat", ext: "chat", label: "Chat", icon: NEW_FILETYPE_ICONS.chat },
  {
    id: "ipynb",
    ext: "ipynb",
    label: "Notebook",
    icon: NEW_FILETYPE_ICONS.ipynb,
  },
  { id: "term", ext: "term", label: "Terminal", icon: NEW_FILETYPE_ICONS.term },
  {
    id: "course",
    ext: "course",
    label: "Course",
    icon: NEW_FILETYPE_ICONS.course,
  },
  { id: "tex", ext: "tex", label: "LaTeX", icon: NEW_FILETYPE_ICONS.tex },
  { id: "py", ext: "py", label: "Python", icon: NEW_FILETYPE_ICONS.py },
  { id: "md", ext: "md", label: "Markdown", icon: NEW_FILETYPE_ICONS.md },
  {
    id: "slides",
    ext: "slides",
    label: "Slides",
    icon: NEW_FILETYPE_ICONS.slides,
  },
  { id: "board", ext: "board", label: "Board", icon: NEW_FILETYPE_ICONS.board },
  { id: "tasks", ext: "tasks", label: "Tasks", icon: NEW_FILETYPE_ICONS.tasks },
  { id: "jl", ext: "jl", label: "Julia", icon: NEW_FILETYPE_ICONS.jl },
  { id: "r", ext: "r", label: "R", icon: NEW_FILETYPE_ICONS.r },
  { id: "qmd", ext: "qmd", label: "Quarto", icon: NEW_FILETYPE_ICONS.qmd },
  { id: "rmd", ext: "rmd", label: "R Markdown", icon: NEW_FILETYPE_ICONS.rmd },
];

export const QUICK_CREATE_MAP: Record<string, QuickCreateSpec> =
  QUICK_CREATE_CATALOG.reduce(
    (acc, spec) => {
      acc[spec.id] = spec;
      return acc;
    },
    {} as Record<string, QuickCreateSpec>,
  );

export function getQuickCreateSpec(id: string): QuickCreateSpec {
  const spec = QUICK_CREATE_MAP[id];
  if (spec != null) return spec;
  const data = file_options(`x.${id}`);
  return {
    id,
    ext: id,
    label: capitalize(data.name ?? id),
    icon: data.icon ?? "file",
  };
}

export function isQuickCreateAvailable(
  id: string,
  availableFeatures?: Partial<Available>,
): boolean {
  if (availableFeatures == null) return true;
  switch (id) {
    case "ipynb":
      return availableFeatures.jupyter_notebook !== false;
    case "sage":
      return availableFeatures.sage !== false;
    case "tex":
      return availableFeatures.latex !== false;
    case "qmd":
      return availableFeatures.qmd !== false;
    case "rmd":
      return availableFeatures.rmd !== false;
    default:
      return true;
  }
}
