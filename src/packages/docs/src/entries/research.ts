/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import {
  RESEARCH_REPRODUCE_BODY,
  RESEARCH_MIGRATION_BODY,
  RESEARCH_RESUME_BODY,
} from "../content/research-workflows";
import {
  RESEARCH_REMOTE_CLI_BODY,
  RESEARCH_DASHBOARD_BODY,
  RESEARCH_CODEX_SESSIONS_BODY,
} from "../content/research-remote";
import {
  RESEARCH_RECOVERY_BODY,
  RESEARCH_GPU_BODY,
  RESEARCH_QUARTO_BODY,
} from "../content/research-specialist";

export const RESEARCH_ENTRIES: DocsEntry[] = [
  {
    body: RESEARCH_REPRODUCE_BODY.trim(),
    audiences: ["agents", "researchers", "teams"],
    category: "Research workflows",
    id: "research.reproduce-analysis",
    lastReviewed: "2026-09-11",
    noActionReason:
      "This multi-step guide uses example files and a project selected by the reader.",
    searchKeywords:
      "reproducible Python research independent rerun input hash environment RootFS",
    slug: "research/reproduce-analysis",
    status: "ready",
    summary:
      "Run a complete example twice, compare input hashes and saved results, and record the research environment.",
    title: "Reproduce a Python analysis in a fresh project",
  },
  {
    body: RESEARCH_MIGRATION_BODY.trim(),
    audiences: ["agents", "researchers", "teams"],
    category: "Research workflows",
    id: "research.notebook-migration",
    lastReviewed: "2026-09-11",
    noActionReason:
      "This multi-step guide uses example files and a project selected by the reader.",
    searchKeywords:
      "import migration Colab Jupyter notebook dependencies ModuleNotFoundError FileNotFoundError",
    slug: "research/notebook-migration",
    status: "ready",
    summary:
      "Transfer a notebook and its data, select the right kernel, replace platform-specific assumptions, and check a fresh run.",
    title: "Move a Jupyter or Colab notebook into CoCalc",
  },
  {
    body: RESEARCH_RESUME_BODY.trim(),
    audiences: ["agents", "researchers", "teams"],
    category: "Research workflows",
    id: "research.resume-computation",
    lastReviewed: "2026-09-11",
    noActionReason:
      "This multi-step guide uses example files and a project selected by the reader.",
    searchKeywords:
      "long running disconnect resume recovery checkpoint Python sweep terminal",
    slug: "research/resume-computation",
    status: "ready",
    summary:
      "Run a checkpointed Python example, deliberately fail it, resume unfinished cases, and verify the saved results.",
    title: "Resume a computation after interruption",
  },
  {
    body: RESEARCH_REMOTE_CLI_BODY.trim(),
    audiences: ["agents", "researchers", "teams"],
    category: "Research workflows",
    id: "research.remote-cli",
    lastReviewed: "2026-09-11",
    noActionReason:
      "This multi-step guide uses example files and a project selected by the reader.",
    searchKeywords:
      "remote research workstation CLI file put get upload download exit_code",
    slug: "research/remote-cli",
    status: "ready",
    summary:
      "Upload inputs with the CLI, execute in a CoCalc project, inspect the remote result, and retrieve a checked artifact.",
    title: "Run a research analysis from your laptop",
  },
  {
    body: RESEARCH_RECOVERY_BODY.trim(),
    audiences: ["agents", "researchers", "teams"],
    category: "Research workflows",
    id: "research.recover-work",
    lastReviewed: "2026-09-11",
    noActionReason:
      "This multi-step guide uses example files and a project selected by the reader.",
    searchKeywords:
      "deleted notebook restore recovery TimeTravel HOME rootfs snapshot backup clone",
    slug: "research/recover-work",
    status: "ready",
    summary:
      "Choose file history, snapshots, backups, or a clone, and practice restoring a checked copy without overwriting current work.",
    title: "Recover research files and environments",
  },
  {
    body: RESEARCH_DASHBOARD_BODY.trim(),
    audiences: ["agents", "researchers", "teams"],
    category: "Research workflows",
    id: "research.private-dashboard",
    lastReviewed: "2026-09-11",
    noActionReason:
      "This multi-step guide uses example files and a project selected by the reader.",
    searchKeywords:
      "dashboard private app server collaborator port readiness logs Python managed",
    slug: "research/private-dashboard",
    status: "ready",
    summary:
      "Launch a small managed HTTP app, verify readiness and collaborator access, inspect failures, and stop it.",
    title: "Share a private research dashboard",
  },
  {
    body: RESEARCH_CODEX_SESSIONS_BODY.trim(),
    audiences: ["agents", "researchers", "teams"],
    category: "Research workflows",
    id: "research.codex-sessions",
    lastReviewed: "2026-09-11",
    noActionReason:
      "This multi-step guide uses example files and a project selected by the reader.",
    searchKeywords:
      "Codex remote agent session thread resume interrupt CLI JSONL",
    slug: "research/codex-sessions",
    status: "ready",
    summary:
      "Start a bounded CLI agent task, retain its continuation identifier, inspect sessions, and interrupt a selected task.",
    title: "Run and continue remote Codex tasks",
  },
  {
    body: RESEARCH_GPU_BODY.trim(),
    audiences: ["agents", "researchers", "teams"],
    category: "Research workflows",
    id: "research.gpu-notebook",
    lastReviewed: "2026-09-11",
    noActionReason:
      "This multi-step guide uses example files and a project selected by the reader.",
    searchKeywords: "PyTorch CUDA GPU Jupyter notebook nvidia device training",
    slug: "research/gpu-notebook",
    status: "ready",
    summary:
      "Check compute and CUDA software separately, calculate on a GPU, and save device and result evidence.",
    title: "Run and verify a PyTorch GPU notebook",
  },
  {
    body: RESEARCH_QUARTO_BODY.trim(),
    audiences: ["agents", "researchers", "teams"],
    category: "Research workflows",
    id: "research.quarto-report",
    lastReviewed: "2026-09-11",
    noActionReason:
      "This multi-step guide uses example files and a project selected by the reader.",
    searchKeywords:
      "R Quarto qmd reproducible report knitr rmarkdown HTML render",
    slug: "research/quarto-report",
    status: "ready",
    summary:
      "Render a complete R analysis and plot to HTML, inspect the output, and preserve the inputs and environment for a collaborator.",
    title: "Create a reproducible R report with Quarto",
  },
];
