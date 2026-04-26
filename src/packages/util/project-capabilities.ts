/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { to_human_list } from "./misc";
import { R_IDE } from "./consts/ui";

export interface ProjectCapabilitySpec {
  key: string;
  label: string;
  probeSummary: string;
  installHint?: string;
}

export const PROJECT_CAPABILITY_SPECS: readonly ProjectCapabilitySpec[] = [
  {
    key: "spellcheck",
    label: "Spellchecking",
    probeSummary: "command -v aspell",
  },
  {
    key: "gitlfs",
    label: "Git LFS",
    probeSummary: "command -v git-lfs",
  },
  {
    key: "imagemagick",
    label: "ImageMagick",
    probeSummary: "command -v magick || command -v convert",
  },
  {
    key: "ffmpeg",
    label: "ffmpeg",
    probeSummary: "command -v ffmpeg",
  },
  {
    key: "typst",
    label: "Typst",
    probeSummary: "command -v typst",
  },
  {
    key: "sshd",
    label: "SSH / SCP access",
    probeSummary: "[ -x /usr/sbin/sshd ] || command -v dropbear",
  },
  {
    key: "rmd",
    label: "RMarkdown",
    probeSummary: "command -v R",
  },
  {
    key: "qmd",
    label: "Quarto",
    probeSummary: "command -v quarto",
  },
  {
    key: "sage",
    label: "SageMath",
    probeSummary: "command -v sage",
  },
  {
    key: "jupyter_notebook",
    label: "Classical Jupyter Notebook",
    probeSummary: "command -v jupyter && command -v jupyter-notebook",
  },
  {
    key: "jupyter_lab",
    label: "JupyterLab",
    probeSummary: "command -v jupyter && command -v jupyter-lab",
  },
  {
    key: "latex",
    label: "LaTeX",
    probeSummary:
      "command -v pdflatex && command -v latexmk && command -v synctex && command -v sha1sum",
  },
  {
    key: "html2pdf",
    label: "HTML to PDF via Chrome/Chromium",
    probeSummary: "command -v chromium-browser || command -v google-chrome",
    installHint: `On Ubuntu, one working path is:\n\nsudo apt-get update && sudo apt-get install -y software-properties-common\nsudo add-apt-repository -y ppa:xtradeb/apps\nsudo apt-get install -y chromium`,
  },
  {
    key: "pandoc",
    label: "File format conversions via pandoc",
    probeSummary: "command -v pandoc",
  },
  {
    key: "vscode",
    label: "VSCode",
    probeSummary: "command -v code-server",
  },
  {
    key: "nodejs",
    label: "Node.js toolchain",
    probeSummary: "command -v node && command -v npm && command -v pnpm",
  },
  {
    key: "julia",
    label: "Julia programming language",
    probeSummary: "command -v julia",
  },
  {
    key: "rserver",
    label: R_IDE,
    probeSummary: "command -v rserver",
  },
] as const;

export function getProjectCapabilitySpec(
  key: string,
): ProjectCapabilitySpec | undefined {
  return PROJECT_CAPABILITY_SPECS.find((spec) => spec.key === key);
}

export function buildProjectCapabilityAgentPrompt(
  spec: ProjectCapabilitySpec,
): string {
  const parts = [
    `Install or enable ${spec.label} for this project if possible.`,
    `CoCalc checks this capability using:\n${spec.probeSummary}`,
  ];
  if (spec.installHint) {
    parts.push(`Install hint:\n${spec.installHint}`);
  }
  parts.push(
    `Work directly in the project, run the same check after making changes, and explain any remaining limitation if ${spec.label} still cannot be enabled.`,
  );
  return parts.join("\n\n");
}

export function formatterProbeSummary(tool: string): string {
  if (tool === "prettier") {
    return "Bundled by default as a JavaScript dependency inside CoCalc.";
  }
  if (tool === "formatR") {
    return "command -v R";
  }
  if (tool === "bib-biber") {
    return "command -v biber";
  }
  if (tool === "xml-tidy" || tool === "tidy") {
    return "command -v tidy";
  }
  return `command -v ${tool}`;
}

export function buildFormatterAgentPrompt(opts: {
  tool: string;
  languages: string[];
}): string {
  const { tool, languages } = opts;
  return [
    `Install or enable the ${tool} formatter for this project if possible.`,
    `This formatter is used for ${to_human_list(languages)}.`,
    `CoCalc checks this formatter using:\n${formatterProbeSummary(tool)}`,
    `Work directly in the project, run the same check after making changes, and explain any remaining limitation if ${tool} still cannot be enabled.`,
  ].join("\n\n");
}
