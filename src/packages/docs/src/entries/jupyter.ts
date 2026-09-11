/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon, projectActionParameters } from "../helpers";
import {
  CREATE_JUPYTER_BODY,
  CUSTOM_JUPYTER_KERNELS_BODY,
  JUPYTER_STUDIO_BODY,
  OCTAVE_JUPYTER_KERNEL_BODY,
  REMOTE_JUPYTER_KERNELS_BODY,
  USE_JUPYTER_BODY,
} from "../content";

export const JUPYTER_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: REMOTE_JUPYTER_KERNELS_BODY.trim(),
    category: "Jupyter",
    id: "jupyter.remote-kernels",
    image: docsIcon(
      "/public/docs/custom-jupyter-kernels-58a40bde.webp",
      "A Jupyter kernel connected to a separate computing environment",
    ),
    lastReviewed: "2026-09-11",
    noActionReason:
      "Remote kernel setup requires a project-specific SSH destination and is configured in the notebook kernel selector.",
    searchKeywords:
      "remote kernel SSH GPU CUDA PyTorch SageJS Bash external compute dedicated VM datasets no file sync",
    slug: "jupyter/remote-kernels",
    status: "ready",
    summary:
      "Use another machine's Jupyter kernel or GPU from a collaborative CoCalc notebook, without automatically synchronizing files.",
    title: "Remote Jupyter kernels",
  },
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
    lastReviewed: "2026-09-07",
    slug: "jupyter/use-jupyter",
    status: "ready",
    summary:
      "Use collaborative durable Jupyter notebooks inside CoCalc projects.",
    title: "Use Jupyter notebooks",
  },
  {
    audiences: ["instructors", "researchers", "students", "teams"],
    body: JUPYTER_STUDIO_BODY.trim(),
    category: "Jupyter",
    id: "jupyter.studio-view",
    lastReviewed: "2026-08-17",
    noActionReason:
      "The Studio view is a per-frame layout choice made inside an open notebook.",
    searchKeywords:
      "studio view reading mode notebook layout minimap table of contents sections markdown headings fold collapse run section presentation output focused classic view frame",
    slug: "jupyter/studio-view",
    status: "ready",
    summary:
      "Navigate, run, and present a notebook in the content-first Studio view, with markdown headings as sections.",
    title: "The Studio notebook view",
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
    lastReviewed: "2026-09-07",
    noActionReason:
      "Kernel setup is a terminal-plus-notebook workflow with project-specific package commands.",
    slug: "jupyter/custom-kernels",
    status: "ready",
    summary:
      "Create a custom Jupyter kernel backed by a uv-managed Python virtual environment.",
    title: "Custom Jupyter kernels with uv",
  },
  {
    audiences: ["instructors", "researchers", "students", "teams"],
    body: OCTAVE_JUPYTER_KERNEL_BODY.trim(),
    category: "Jupyter",
    id: "jupyter.octave-kernel",
    image: docsIcon(
      "/public/docs/custom-jupyter-kernels-58a40bde.webp",
      "A custom Jupyter kernel connected to an isolated project environment",
    ),
    lastReviewed: "2026-07-04",
    noActionReason:
      "Octave setup is a project terminal workflow that installs system packages and registers a kernelspec.",
    searchKeywords:
      "octave gnu octave jupyter kernel octave-kernel matlab project install gnuplot kernelspec",
    siteProfiles: ["cocalc-ai"],
    slug: "jupyter/install-octave-kernel",
    status: "ready",
    summary:
      "Install GNU Octave and octave-kernel into an existing CoCalc AI project without changing the default Python kernel.",
    title: "Install the Octave Jupyter kernel",
  },
];
