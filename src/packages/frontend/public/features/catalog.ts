/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface FeatureSection {
  bullets?: string[];
  links?: Array<{ href: string; label: string }>;
  paragraphs?: string[];
  title: string;
}

export interface FeaturePage {
  aliases?: string[];
  docsUrl?: string;
  image?: string;
  index: boolean;
  slug: string;
  summary: string;
  tagline: string;
  title: string;
  sections?: FeatureSection[];
}

export const FEATURE_PAGES: FeaturePage[] = [
  {
    slug: "jupyter-notebook",
    title: "Jupyter Notebooks",
    tagline:
      "Collaborative notebooks with shared kernels and full edit history.",
    summary:
      "Run Jupyter notebooks inside a shared CoCalc project with collaboration, synchronized output, history, recovery, course workflows, terminals, files, and AI agent context nearby.",
    image: "/public/features/cocalc-jupyter2-20170508.png",
    index: true,
    sections: [
      {
        title: "Why it matters",
        paragraphs: [
          "CoCalc notebooks stay compatible with the Jupyter ecosystem while adding collaboration, teaching, recovery, terminals, files, and AI agent context that are awkward to bolt on later.",
          "Kernel state, output, and widgets can be shared across collaborators, which makes notebooks practical for classes, research groups, engineering teams, and support sessions.",
        ],
      },
      {
        title: "Highlights",
        bullets: [
          "Real-time collaborative editing with visible cursors and shared kernel sessions",
          "Built-in TimeTravel and recovery tools for recovering earlier notebook states",
          "Course and lab workflows for distributing, collecting, and grading notebook assignments",
          "Managed kernels with many languages and preinstalled scientific software",
        ],
      },
    ],
  },
  {
    slug: "latex-editor",
    title: "LaTeX Editor",
    tagline: "Write papers, notes, and handouts collaboratively online.",
    summary:
      "Edit LaTeX in the browser with synchronized collaboration, build output, history, and the rest of the CoCalc project environment close by.",
    image: "/public/features/latex-editor-main-20251003.png",
    index: true,
  },
  {
    slug: "ai",
    aliases: ["openai-chatgpt"],
    title: "AI Agents in Project Chat",
    tagline: "Use Codex where the technical work already lives.",
    summary:
      "Work with Codex inside collaborative project threads that stay close to files, notebooks, terminals, screenshots, patches, review notes, and live notebook state.",
    image: "/public/features/chatgpt-fix-code.png",
    docsUrl: "https://sagemathinc.github.io/cocalc-guides/codex-agent-chat/",
    index: true,
    sections: [
      {
        title: "Codex in project threads",
        paragraphs: [
          "CoCalc-AI uses Codex through project chat threads. Human @mentions notify collaborators; they do not invoke models.",
        ],
        bullets: [
          "Use OpenAI API keys or OpenAI subscription plans for native Codex support",
          "Keep prompts, screenshots, patches, and review notes in one durable thread",
          "Let Codex work with files, terminals, and live notebook state",
          "Run other command-line agents in project terminals as normal Linux tools",
        ],
      },
    ],
  },
  {
    slug: "slides",
    title: "Slides",
    tagline: "Present from slide-sized technical whiteboards.",
    summary:
      "Build presentation decks from slide-sized whiteboard pages with markdown, math, diagrams, Jupyter cells, collaboration, and project context.",
    image: "/public/features/whiteboard-sage.png",
    index: true,
  },
  {
    slug: "whiteboard",
    title: "Whiteboard",
    tagline: "A collaborative technical canvas for math, code, and sketches.",
    summary:
      "Use an infinite collaborative canvas with markdown, KaTeX, Jupyter cells, multiple pages, and a transparent JSONL document format.",
    image: "/public/features/whiteboard-sage.png",
    index: true,
  },
  {
    slug: "r-statistical-software",
    title: "R Statistical Software",
    tagline: "Use R when statistics is part of a larger project workflow.",
    summary:
      "Work with R in notebooks, terminals, scripts, RMarkdown-style documents, Quarto-style workflows, Knitr, and shared course projects.",
    image: "/public/features/cocalc-r-jupyter.png",
    index: true,
  },
  {
    slug: "sage",
    title: "SageMath",
    tagline:
      "Use SageMath in the collaborative environment with deep roots in Sage.",
    summary:
      "Use SageMath for teaching, notebooks, SageTeX documents, source development, and long-running mathematics computations in a real collaborative Linux project.",
    image: "/public/features/sagemath-jupyter.png",
    index: true,
  },
  {
    slug: "octave",
    title: "GNU Octave",
    tagline: "Run Octave online in notebooks, scripts, and terminals.",
    summary:
      "Use GNU Octave for MATLAB-style numerical computing in collaborative projects with notebooks, .m files, terminals, plots, and teaching workflows.",
    image: "/public/features/cocalc-octave-jupyter-20200511.png",
    index: true,
  },
  {
    slug: "python",
    title: "Python",
    tagline: "A broad scientific Python stack ready in the browser.",
    summary:
      "Use Python for technical computing, data science, and machine learning with a large preinstalled package set and collaborative tooling around it.",
    image: "/public/features/frame-editor-python.png",
    index: true,
  },
  {
    slug: "julia",
    title: "Julia",
    tagline: "Use Julia in notebooks, terminals, Pluto, and source files.",
    summary:
      "Run Julia in a collaborative project with Jupyter notebooks, Pluto, package environments, source files, terminals, and course workflows.",
    image: "/public/features/julia-jupyter.png",
    index: true,
  },
  {
    slug: "terminal",
    title: "Linux Terminal",
    tagline: "A collaborative remote shell inside every project.",
    summary:
      "Work in a shared Linux shell, keep tools and files near your notebooks and documents, and avoid local environment drift.",
    image: "/public/features/terminal.png",
    index: true,
    sections: [
      {
        title: "Practical shell workflows",
        bullets: [
          "Run commands and scripts in the same project as notebooks and documents",
          "Share terminal sessions with collaborators",
          "Keep long-running technical work in the browser instead of on a single laptop",
        ],
      },
    ],
  },
  {
    slug: "linux",
    title: "Online Linux Environment",
    tagline: "A browser-based Linux workspace for technical projects.",
    summary:
      "Treat CoCalc projects as collaborative Linux environments with editors, terminals, files, and web-accessible services.",
    image: "/public/features/cocalc-shell-script-run.png",
    index: true,
  },
  {
    slug: "teaching",
    title: "Technical Courses and Labs",
    tagline:
      "Run technical courses and labs with shared infrastructure and grading tools.",
    summary:
      "Organize assignments, distribute files, collect work, and grade notebooks or other project files with a workflow built for technical courses, labs, and training environments.",
    image: "/public/features/cocalc-course-assignments-2019.png",
    index: true,
    sections: [
      {
        title: "Designed for technical classes and labs",
        bullets: [
          "Course management for assignments and shared course resources",
          "Notebook grading workflows including nbgrader support",
          "A single environment for coding, computation, handouts, and collaboration",
        ],
      },
    ],
  },
  {
    slug: "api",
    title: "HTTP API",
    tagline: "Automate and integrate CoCalc from external systems.",
    summary:
      "Use the CoCalc HTTP API for automation, integration, and provisioning workflows without depending on the web UI.",
    image: "/public/features/api-screenshot.png",
    index: true,
    sections: [
      {
        title: "Use cases",
        bullets: [
          "Provision and manage projects programmatically",
          "Integrate account, billing, and support flows",
          "Build external tools that talk to CoCalc over HTTP",
        ],
      },
    ],
  },
  {
    slug: "compare",
    title: "Compare CoCalc",
    tagline: "A concise view of what CoCalc bundles into one workspace.",
    summary:
      "CoCalc combines notebooks, terminals, documents, AI agents, course tools, sharing, recovery, and collaborative editing in one web-based technical workspace.",
    index: true,
  },
  {
    slug: "icons",
    title: "Feature Assets",
    tagline: "Legacy asset references used by older public links.",
    summary:
      "This route is kept available so older links to feature assets still resolve cleanly.",
    index: false,
  },
  {
    slug: "i18n",
    title: "Internationalization",
    tagline: "Localization and translation support across the public site.",
    summary:
      "CoCalc supports translated public pages and localized product interfaces.",
    index: false,
  },
];

const FEATURE_PAGE_MAP = new Map<string, FeaturePage>();

for (const page of FEATURE_PAGES) {
  FEATURE_PAGE_MAP.set(page.slug, page);
  for (const alias of page.aliases ?? []) {
    FEATURE_PAGE_MAP.set(alias, page);
  }
}

export function getFeaturePage(slug?: string): FeaturePage | undefined {
  if (!slug) return;
  return FEATURE_PAGE_MAP.get(slug);
}

export function getFeatureIndexPages(): FeaturePage[] {
  return FEATURE_PAGES.filter((page) => page.index);
}
