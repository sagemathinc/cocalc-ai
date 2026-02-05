/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { IconName } from "@cocalc/frontend/components/icon";
import { NEW_FILETYPE_ICONS } from "./consts";
import { SPEC } from "../named-server-panel";
import { R_IDE } from "@cocalc/util/consts/ui";
import type { NamedServerName } from "@cocalc/util/types/servers";

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
  { id: "md", ext: "md", label: "Markdown", icon: NEW_FILETYPE_ICONS.md },
  { id: "tex", ext: "tex", label: "LaTeX", icon: NEW_FILETYPE_ICONS.tex },
  { id: "qmd", ext: "qmd", label: "Quarto", icon: NEW_FILETYPE_ICONS.qmd },
  { id: "rmd", ext: "rmd", label: "R Markdown", icon: NEW_FILETYPE_ICONS.rmd },
  { id: "py", ext: "py", label: "Python", icon: NEW_FILETYPE_ICONS.py },
  { id: "jl", ext: "jl", label: "Julia", icon: NEW_FILETYPE_ICONS.jl },
  { id: "r", ext: "r", label: "R", icon: NEW_FILETYPE_ICONS.r },
  { id: "term", ext: "term", label: "Terminal", icon: NEW_FILETYPE_ICONS.term },
  {
    id: "slides",
    ext: "slides",
    label: "Slides",
    icon: NEW_FILETYPE_ICONS.slides,
  },
  { id: "tasks", ext: "tasks", label: "Tasks", icon: NEW_FILETYPE_ICONS.tasks },
  { id: "board", ext: "board", label: "Board", icon: NEW_FILETYPE_ICONS.board },
];

export const QUICK_CREATE_MAP: Record<string, QuickCreateSpec> =
  QUICK_CREATE_CATALOG.reduce(
    (acc, spec) => {
      acc[spec.id] = spec;
      return acc;
    },
    {} as Record<string, QuickCreateSpec>,
  );

export interface AppSpec {
  id: NamedServerName;
  label: string;
  icon: IconName;
}

export const APP_CATALOG: AppSpec[] = [
  { id: "jupyterlab", label: "JupyterLab", icon: SPEC.jupyterlab.icon },
  { id: "code", label: "VS Code", icon: SPEC.code.icon },
  { id: "jupyter", label: "Jupyter Classic", icon: SPEC.jupyter.icon },
  { id: "pluto", label: "Pluto (Julia)", icon: SPEC.pluto.icon },
  { id: "rserver", label: R_IDE, icon: SPEC.rserver.icon },
];

export const APP_MAP: Record<string, AppSpec> = APP_CATALOG.reduce(
  (acc, spec) => {
    acc[spec.id] = spec;
    return acc;
  },
  {} as Record<string, AppSpec>,
);
