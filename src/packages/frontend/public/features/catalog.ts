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
      "Run Jupyter notebooks directly in the browser with collaboration, synchronized output, time travel, and course workflows built in.",
    image: "/public/features/cocalc-jupyter2-20170508.png",
    docsUrl: "https://doc.cocalc.com/jupyter.html",
    index: true,
    sections: [
      {
        title: "Why it matters",
        paragraphs: [
          "CoCalc notebooks stay compatible with the Jupyter ecosystem while adding the collaboration, teaching, and operational features that are awkward to bolt on later.",
          "Kernel state, output, and widgets can be shared across collaborators, which makes notebooks practical for classes, pair work, and support sessions.",
        ],
      },
      {
        title: "Highlights",
        bullets: [
          "Real-time collaborative editing with visible cursors and shared kernel sessions",
          "Built-in time travel and snapshot history for recovering earlier notebook states",
          "Course workflows for distributing, collecting, and grading notebook assignments",
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
    docsUrl: "https://doc.cocalc.com/latex.html",
    index: true,
  },
  {
    slug: "ai",
    aliases: ["openai-chatgpt"],
    title: "Coding Agents and AI Assistance",
    tagline: "Use coding agents and LLM help directly in the workspace.",
    summary:
      "Work with coding agents inside chat and project workflows to explain code, fix errors, generate files, and help move technical work forward.",
    image: "/public/features/chatgpt-fix-code.png",
    docsUrl: "https://doc.cocalc.com/chat.html",
    index: true,
    sections: [
      {
        title: "Agent-native workflows",
        paragraphs: [
          "The current direction is not generic chat boxes. It is coding agents that can inspect context, write code, and participate in the same collaborative environment as the rest of the team.",
        ],
        bullets: [
          "Understand and fix code or notebook errors",
          "Generate or rewrite project files",
          "Help with shell commands, environments, and debugging",
          "Stay embedded in the same chat and document workflows as the rest of CoCalc",
        ],
      },
    ],
  },
  {
    slug: "slides",
    title: "Slides",
    tagline: "Present technical work with executable, collaborative slides.",
    summary:
      "Build slides that live next to code, notebooks, whiteboards, and the rest of your project instead of in a disconnected presentation tool.",
    image: "/public/features/whiteboard-sage.png",
    index: true,
  },
  {
    slug: "whiteboard",
    title: "Whiteboard",
    tagline: "Sketch, annotate, and explain ideas collaboratively.",
    summary:
      "Use an infinite collaborative whiteboard for diagrams, sketches, and teaching, with the rest of the project close by.",
    image: "/public/features/whiteboard-sage.png",
    index: true,
  },
  {
    slug: "r-statistical-software",
    title: "R Statistical Software",
    tagline:
      "Use R in notebooks, terminals, and reproducible document workflows.",
    summary:
      "Work with R inside CoCalc using notebooks, terminals, and document-generation tools without managing local setup on every machine.",
    image: "/public/features/cocalc-r-jupyter.png",
    index: true,
  },
  {
    slug: "sage",
    title: "SageMath",
    tagline: "Use SageMath online in the environment built by the same team.",
    summary:
      "CoCalc has deep SageMath support, including notebooks, terminals, and integration with the broader collaborative workspace.",
    image: "/public/features/sagemath-jupyter.png",
    index: true,
  },
  {
    slug: "octave",
    title: "GNU Octave",
    tagline:
      "Run Octave online with notebooks and terminals available immediately.",
    summary:
      "Use Octave in collaborative projects without local installation and pair it with notebooks, terminals, and course workflows.",
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
    tagline: "Use Julia with notebooks, terminals, and project workflows.",
    summary:
      "Run Julia in CoCalc using notebooks or terminals, with collaboration and course support already integrated.",
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
    docsUrl: "https://doc.cocalc.com/terminal.html",
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
    title: "Teaching a Course",
    tagline:
      "Run technical courses with shared infrastructure and grading tools.",
    summary:
      "Organize assignments, distribute files, collect work, and grade notebooks or other project files with a workflow built for technical classes.",
    image: "/public/features/cocalc-course-assignments-2019.png",
    docsUrl: "https://doc.cocalc.com/teaching-instructors.html",
    index: true,
    sections: [
      {
        title: "Designed for technical classes",
        bullets: [
          "Course management for assignments and shared course resources",
          "Notebook grading workflows including nbgrader support",
          "A single environment for coding, computation, handouts, and collaboration",
        ],
      },
    ],
  },
  {
    slug: "x11",
    title: "Linux Graphical Desktop",
    tagline: "Run graphical Linux applications remotely in the browser.",
    summary:
      "Use remote graphical applications alongside terminals, notebooks, and project files when you need more than a text shell.",
    image: "/public/features/x11-01.png",
    docsUrl: "https://doc.cocalc.com/x11.html",
    index: true,
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
    tagline: "A concise view of what CoCalc bundles into one environment.",
    summary:
      "CoCalc combines notebooks, terminals, documents, course tools, sharing, and collaborative editing in one web-based technical workspace.",
    index: true,
  },
  {
    slug: "icons",
    title: "Feature Assets",
    tagline: "Internal asset page retained for compatibility.",
    summary:
      "This route exists for compatibility during the Next.js migration.",
    index: false,
  },
  {
    slug: "i18n",
    title: "Internationalization",
    tagline:
      "Localization work remains available while the public site is migrated.",
    summary:
      "This route exists for compatibility during the Next.js migration.",
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
