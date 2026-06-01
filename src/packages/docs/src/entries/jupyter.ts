/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon, projectActionParameters } from "../helpers";
import {
  CREATE_JUPYTER_BODY,
  CUSTOM_JUPYTER_KERNELS_BODY,
  USE_JUPYTER_BODY,
} from "../content";

export const JUPYTER_ENTRIES: DocsEntry[] = [
  {
    actions: [
      {
        description: "Create a Jupyter notebook in the active project.",
        executable: true,
        id: "project.jupyter.create",
        label: "Create notebook",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "students"],
    body: CREATE_JUPYTER_BODY.trim(),
    category: "Jupyter",
    id: "jupyter.create-notebook",
    image: docsIcon(
      "/public/docs/create-jupyter-ddc9795c.webp",
      "A new Jupyter notebook with code cells and a kernel gear",
    ),
    lastReviewed: "2026-05-24",
    slug: "jupyter/create-notebook",
    status: "ready",
    summary:
      "Create notebooks that keep running and capturing output after browser disconnects.",
    title: "Create a Jupyter notebook",
  },
  {
    actions: [
      {
        description: "Create a Jupyter notebook in the active project.",
        executable: true,
        id: "jupyter.open",
        label: "Create notebook",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: USE_JUPYTER_BODY.trim(),
    category: "Jupyter",
    id: "jupyter.use-jupyter",
    image: docsIcon(
      "/public/docs/use-jupyter-bcc9b49c.webp",
      "A collaborative Jupyter notebook with output and a running kernel",
    ),
    lastReviewed: "2026-05-24",
    slug: "jupyter/use-jupyter",
    status: "ready",
    summary:
      "Use collaborative durable Jupyter notebooks inside CoCalc projects.",
    title: "Use Jupyter notebooks",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students"],
    body: CUSTOM_JUPYTER_KERNELS_BODY.trim(),
    category: "Jupyter",
    id: "jupyter.custom-kernels",
    image: docsIcon(
      "/public/docs/custom-jupyter-kernels-58a40bde.webp",
      "A custom Jupyter kernel connected to an isolated Python environment",
    ),
    lastReviewed: "2026-05-24",
    slug: "jupyter/custom-kernels",
    status: "ready",
    summary:
      "Create a custom Jupyter kernel backed by a uv-managed Python virtual environment.",
    title: "Custom Jupyter kernels with uv",
  },
];
