/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon, projectActionParameters } from "../helpers";
import {
  FILE_EXPLORER_BODY,
  GIT_BODY,
  LATEX_BODY,
  MARKDOWN_BODY,
  PROJECT_FILES_BODY,
  PYTHON_BODY,
  R_MARKDOWN_BODY,
  SLIDES_BODY,
  TIMETRAVEL_BODY,
  WHITEBOARD_BODY,
} from "../content";

export const FILES_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: PROJECT_FILES_BODY.trim(),
    category: "Files",
    id: "files.project-files",
    image: docsIcon(
      "/public/docs/project-files-6c4ff552.webp",
      "A shared project folder with notebooks, scripts, data, and output",
    ),
    lastReviewed: "2026-05-24",
    slug: "files/project-files",
    status: "ready",
    summary:
      "Use the project filesystem as the shared place for notebooks, scripts, datasets, and output.",
    title: "Work with project files",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: FILE_EXPLORER_BODY.trim(),
    category: "Files",
    id: "files.explorer",
    image: docsIcon(
      "/public/docs/file-explorer-d0e7d92d.webp",
      "A project file browser with folders, file types, and search",
    ),
    lastReviewed: "2026-05-25",
    slug: "files/explorer",
    status: "ready",
    summary: "Create, open, upload, rename, move, and organize project files.",
    title: "Use the file explorer",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: MARKDOWN_BODY.trim(),
    category: "Files",
    id: "files.markdown",
    image: docsIcon(
      "/public/docs/markdown-dab5a1ac.webp",
      "A Markdown document with headings, checklists, and a code block",
    ),
    lastReviewed: "2026-05-25",
    slug: "files/markdown",
    status: "ready",
    summary:
      "Write README files, notes, instructions, math, code blocks, and collaborative documentation.",
    title: "Use Markdown",
  },
  {
    audiences: ["instructors", "researchers", "students", "teams"],
    body: SLIDES_BODY.trim(),
    category: "Files",
    id: "files.slides",
    image: docsIcon(
      "/public/docs/slides-84a00de7.webp",
      "Presentation slides with charts, images, and a projected screen",
    ),
    lastReviewed: "2026-05-25",
    slug: "files/slides",
    status: "ready",
    summary:
      "Create presentation slides that live with the project files they explain.",
    title: "Create slides",
  },
  {
    audiences: ["instructors", "researchers", "students", "teams"],
    body: WHITEBOARD_BODY.trim(),
    category: "Files",
    id: "files.whiteboard",
    image: docsIcon(
      "/public/docs/whiteboard-d2b02f98.webp",
      "A collaborative whiteboard with sticky notes, sketches, and arrows",
    ),
    lastReviewed: "2026-05-25",
    slug: "files/whiteboard",
    status: "ready",
    summary:
      "Sketch diagrams, lecture notes, and visual plans in a collaborative project file.",
    title: "Use whiteboards",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: PYTHON_BODY.trim(),
    category: "Python",
    id: "python.use-python",
    image: docsIcon(
      "/public/docs/python-93480a33.webp",
      "Python work across notebooks, scripts, terminals, and plots",
    ),
    lastReviewed: "2026-05-24",
    slug: "python/use-python",
    status: "ready",
    summary:
      "Use real Python through notebooks, scripts, terminals, virtual environments, and papers.",
    title: "Use Python in CoCalc",
  },
  {
    audiences: ["instructors", "researchers", "students", "teams"],
    body: LATEX_BODY.trim(),
    category: "LaTeX",
    id: "latex.build-papers",
    image: docsIcon(
      "/public/docs/latex-15ab38f8.webp",
      "A LaTeX paper with formulas, references, and a compiled PDF",
    ),
    lastReviewed: "2026-05-25",
    slug: "latex/build-papers",
    status: "ready",
    summary:
      "Write and build LaTeX papers, assignments, reports, figures, and bibliographies.",
    title: "Build LaTeX documents",
  },
  {
    audiences: ["instructors", "researchers", "students"],
    body: R_MARKDOWN_BODY.trim(),
    category: "R",
    id: "editors.r-markdown",
    image: docsIcon(
      "/public/docs/python-93480a33.webp",
      "A reproducible report combining prose, code chunks, plots, and output",
    ),
    lastReviewed: "2026-05-25",
    slug: "editors/r-markdown",
    status: "ready",
    summary:
      "Write reproducible R reports with Markdown prose, R chunks, plots, and rendered output.",
    title: "Use R Markdown",
  },
  {
    actions: [
      {
        description: "Open TimeTravel for the active file.",
        executable: true,
        id: "file.timetravel.open",
        label: "Open TimeTravel",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: TIMETRAVEL_BODY.trim(),
    category: "Files",
    id: "files.timetravel",
    image: docsIcon(
      "/public/docs/timetravel-0f06290b.webp",
      "A TimeTravel timeline with Git revisions, snapshots, and restore points",
    ),
    lastReviewed: "2026-05-24",
    slug: "files/timetravel",
    status: "ready",
    summary: "Inspect, compare, and recover the history of files in a project.",
    title: "Use TimeTravel",
  },
  {
    audiences: ["agents", "researchers", "students", "teams"],
    body: GIT_BODY.trim(),
    category: "Files",
    id: "files.git",
    image: docsIcon(
      "/public/docs/git-a53df3e8.webp",
      "Git branch history beside project files",
    ),
    lastReviewed: "2026-05-24",
    slug: "files/git",
    status: "ready",
    summary:
      "Use Git for repository history alongside TimeTravel for file-focused recovery.",
    title: "Use Git",
  },
];
