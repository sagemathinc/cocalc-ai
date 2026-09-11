/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface PublicFeatureSection {
  bullets?: string[];
  links?: Array<{ href: string; label: string }>;
  paragraphs?: string[];
  title: string;
}

export interface PublicFeaturePage {
  aliases?: string[];
  docsUrl?: string;
  image?: string;
  index: boolean;
  metadataSummary?: string;
  metadataTitle?: string;
  // Short label for the feature sub-navigation (side rail and the
  // "Features" dropdown in the public top nav). Pages without a navLabel
  // do not appear there. Nav order follows the order of this array.
  navLabel?: string;
  sections?: PublicFeatureSection[];
  slug: string;
  summary: string;
  tagline: string;
  title: string;
}

// Catalog links are authored relative to the site root. Add the deployment
// prefix without changing external URLs, queries, or fragments.
export function publicFeatureHref(href: string, basePath: string): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const prefix = basePath.replace(/\/+$/, "");
  const pathname = href.split(/[?#]/, 1)[0];
  if (!prefix || pathname === prefix || pathname.startsWith(`${prefix}/`)) {
    return href;
  }
  return `${prefix}${href}`;
}

export const PUBLIC_FEATURE_PAGES: PublicFeaturePage[] = [
  {
    slug: "research-compute",
    title: "Research Compute",
    navLabel: "Compute",
    metadataTitle: "CPU, RAM, and GPU Compute for Research",
    tagline: "Keep research code, computation, and collaboration connected.",
    summary:
      "Run larger research workloads in CoCalc, or connect a remote Jupyter kernel to an existing machine and its datasets.",
    metadataSummary:
      "Explore research compute in CoCalc: CPU and RAM requirements, GPU workloads, remote Jupyter kernels, storage, and CLI inspection. Follow the documented setup and operating limits.",
    docsUrl: "/docs/hosts/project-hosts",
    index: true,
    sections: [
      {
        title: "Run the project on suitable compute",
        paragraphs: [
          "A project host runs your CoCalc project's files, notebooks, terminals, and services. Choose resources for the workload and check host access before placing a project there. Options depend on your deployment and account.",
          "Compare the project's RAM policy with the host's physical memory and the number of concurrent jobs. More CPU cores help only when your program can use them. A GPU workload also needs compatible software and enough GPU memory.",
        ],
        links: [
          {
            href: "/docs/hosts/project-hosts",
            label: "Understand project hosts",
          },
          {
            href: "/docs/hosts/access-and-ram",
            label: "Check host access and RAM policy",
          },
          {
            href: "/docs/troubleshooting/memory",
            label: "Investigate memory pressure",
          },
        ],
      },
      {
        title: "Use an existing server or GPU machine",
        paragraphs: [
          "Remote Jupyter kernels let you edit a notebook in CoCalc while its code runs on another machine over SSH. This can keep computation near software or datasets already on that machine. You need suitable access to the remote account and a configured kernel.",
          "The notebook remains in the CoCalc project. Input and output files used by the remote code live on the remote machine; they are not automatically synchronized with project files.",
        ],
        links: [
          {
            href: "/docs/jupyter/remote-kernels",
            label: "Connect a remote Jupyter kernel",
          },
        ],
      },
      {
        title: "Plan for results, interruptions, and larger workloads",
        paragraphs: [
          "Save important results and checkpoints to files before moving or stopping compute. Review the differences between project files, temporary scratch space, host-local snapshots, and backups before a long run.",
          "Moving a project transfers data through backup and restore; it does not transfer running process memory. Check destination compatibility and restart the computation from saved state when appropriate.",
        ],
        links: [
          {
            href: "/docs/hosts/storage",
            label: "Understand storage and recovery",
          },
          { href: "/docs/hosts/move-projects", label: "Plan a project move" },
          {
            href: "/docs/hosts/lifecycle",
            label: "Review host lifecycle actions",
          },
        ],
      },
      {
        title: "Inspect and automate with the CoCalc CLI",
        paragraphs: [
          "Researchers and agents can use the CLI to inspect resources, discover documentation, and work with project files and notebooks. Start by choosing the correct site and authentication profile, then follow the command's prerequisites and result checks.",
        ],
        links: [
          {
            href: "/docs/cli/getting-started",
            label: "Get started with the CoCalc CLI",
          },
          {
            href: "/docs/cli/authentication-and-targets",
            label: "Choose authentication and targets",
          },
          {
            href: "/docs/cli/notebook-workflows",
            label: "Run and save notebooks with the CLI",
          },
        ],
      },
    ],
  },
  {
    slug: "jupyter-notebook",
    title: "Jupyter Notebooks",
    navLabel: "Jupyter",
    metadataTitle: "Online Jupyter Notebooks",
    tagline:
      "Collaborative notebooks with shared kernels and full edit history.",
    summary:
      "Use collaborative Jupyter notebooks when output, files, terminals, history, and review need to stay together.",
    metadataSummary:
      "Run Jupyter notebooks online in a shared CoCalc project: real-time collaboration, chat anchored to cells, TimeTravel history, kernels for Python, SageMath, R, and Julia, course workflows, and AI agent context nearby.",
    image: "/public/features/cocalc-jupyter2-20170508.png",
    index: true,
    sections: [
      {
        title: "Run Jupyter notebooks online",
        paragraphs: [
          "Run Jupyter notebooks online in your browser: type code into a cell, run it, and see the output immediately, with nothing to install on your own machine.",
          "Kernels come from your project's software environment: Python with the scientific stack, SageMath, R, Julia, and more, and kernel state can be shared across collaborators.",
        ],
        bullets: [
          "Real-time collaborative editing with visible cursors and shared kernel sessions",
          "Chat threads anchored to individual cells, plus TimeTravel edit history",
          "Course workflows for distributing, collecting, and grading notebook assignments",
          "CPU and memory gauges in the toolbar, with a Stop button for runaway cells",
        ],
      },
    ],
  },
  {
    slug: "latex-editor",
    title: "LaTeX Editor",
    navLabel: "LaTeX",
    metadataTitle: "Online LaTeX Editor",
    tagline: "Write papers, notes, and handouts collaboratively online.",
    summary:
      "Edit LaTeX in the browser with collaboration, build output, history, and project files close by.",
    metadataSummary:
      "Write LaTeX online with real-time collaboration, side-by-side PDF preview with forward and inverse search, SageTeX, PythonTeX, and Knitr, discussions anchored to the source, and full edit history.",
    image: "/public/features/latex-editor-main-20251003.png",
    index: true,
    sections: [
      {
        title: "Write LaTeX online",
        paragraphs: [
          "Edit LaTeX online in your browser with a side-by-side PDF preview, forward and inverse search, and error messages linked to the source line that caused them.",
          "Collaborators edit the same document in real time, discussions attach to specific lines, and TimeTravel records the full edit history of every file.",
        ],
        bullets: [
          "Complete TeX Live from your software environment, no local installation",
          "Knitr, SageTeX, and PythonTeX documents build in the same editor",
          "Multi-file projects with a table of contents across subfiles",
          "Bibliographies, figures, and data live in the same project",
        ],
      },
    ],
  },
  {
    slug: "terminal",
    title: "Linux Terminal",
    navLabel: "Terminal",
    metadataTitle: "Online Linux Terminal",
    tagline: "A collaborative remote shell inside every project.",
    summary:
      "Work in a shared Linux shell with tools and files near notebooks, documents, and project history.",
    metadataSummary:
      "Use a full Linux terminal online in your browser: collaborative shell sessions that survive disconnects, preinstalled command-line software, and files, notebooks, and AI agents in the same project.",
    image: "/public/features/terminal.png",
    index: true,
    sections: [
      {
        title: "A real Linux terminal online",
        paragraphs: [
          "Use a full Linux terminal online in your browser: a real bash shell in an Ubuntu-based project, not an emulator, with nothing to install and nothing that can break your own machine.",
          "That makes it a safe place to practice Linux commands, and a practical one for real work: sessions survive disconnects, and the same shell can be shared with collaborators.",
        ],
        bullets: [
          "Run commands and scripts in the same project as notebooks and documents",
          "Install more software with apt-get, pip, or npm; your installs persist",
          "Edit a script and run it in a terminal pane right next to the editor",
          "Keep long-running jobs going after you close the browser",
        ],
      },
    ],
  },
  {
    slug: "linux",
    title: "Online Linux Environment",
    navLabel: "Linux",
    tagline: "A browser-based Linux workspace for technical projects.",
    summary:
      "Use CoCalc projects as collaborative Linux environments with editors, terminals, files, and web services.",
    metadataSummary:
      "Use a complete online Linux environment in your browser: Ubuntu-based projects with passwordless sudo, persistent storage and snapshots, SSH access, web services, and collaborative editors and terminals.",
    image: "/public/features/cocalc-shell-script-run.png",
    index: true,
    sections: [
      {
        title: "A complete Linux environment online",
        paragraphs: [
          "Every CoCalc project is a full Ubuntu-based Linux system running in your browser: a complete userland with bash, git, curl, and the package ecosystem of a normal Ubuntu machine; compilers like the gcc toolchain are one apt-get install away.",
          "Passwordless sudo works in every project, and apt-get installs persist in a per-project overlay that survives restarts and moves with the project.",
        ],
        bullets: [
          "Persistent home directory with snapshots as often as every 15 minutes plus off-host backups",
          "Run web apps and services on any port behind an authenticated project URL",
          "SSH, scp, sftp, and rsync access, including project-to-project SSH",
          "Live memory and CPU monitoring, with larger and GPU hosts available",
        ],
      },
    ],
  },
  {
    slug: "x11",
    title: "Linux Graphical Applications",
    navLabel: "X11",
    metadataTitle: "Run Linux Graphical Applications Online",
    tagline: "Wayland and X11 applications streamed into your browser.",
    summary:
      "Run Linux GUI applications in a shared CoCalc project with browser clipboard, sound, persistent sessions, and install-on-demand launchers.",
    metadataSummary:
      "Run Linux graphical applications online with CoCalc: browser-streamed Wayland and X11 windows, clipboard and PipeWire audio, persistent shared sessions, launchers, and an X11 software environment.",
    docsUrl: "/app-docs/terminal/graphical-applications",
    index: true,
    sections: [
      {
        title: "Linux GUI applications in the browser",
        paragraphs: [
          "Open an .x11 file and launch native Wayland or X11 applications inside the same persistent Linux project as your files, terminals, and notebooks.",
          "CoCalc embeds Blit's headless Wayland compositor and uses xwayland-satellite for X11 compatibility, so applications appear as focused browser surfaces instead of inside a traditional remote desktop.",
        ],
        bullets: [
          "Browser clipboard and PipeWire application audio",
          "Install-on-demand launchers and a ready-made X11 software environment",
          "One persistent graphical display shared by every collaborator and browser",
          "Launch applications from the graphical terminal, a normal terminal, scripts, or Jupyter",
        ],
        links: [{ href: "https://blit.sh/", label: "Learn about Blit" }],
      },
    ],
  },
  {
    slug: "software-environment",
    title: "Software Environments",
    navLabel: "Software",
    metadataTitle: "Online Software Environments",
    tagline: "Pick the software image your project runs on.",
    summary:
      "Choose a software image per project — from lean base systems to full scientific stacks — and customize it from there.",
    metadataSummary:
      "Every CoCalc project runs on a software image you choose: lean base systems or full scientific stacks with Python, R, Julia, SageMath, and LaTeX — customizable from inside the project.",
    index: true,
    sections: [
      {
        title: "Pick the software, keep your changes",
        paragraphs: [
          "Every CoCalc project runs on a runtime image you choose: full scientific stacks with Python, SageMath, R, Julia, and TeX Live, GPU images for machine learning, or a lean base system.",
          "Your own installs with apt-get, pip, or npm persist on top of the read-only base image, and you can publish a configured environment as a reusable image for your team or course.",
        ],
        bullets: [
          "Curated catalog with stable and preview channels",
          "Switch a project's image anytime, with one-step rollback to the previous one",
          "Build custom images from a declarative recipe or a Binder-style repository",
          "The base image does not count against your project's disk quota",
        ],
      },
    ],
  },
  {
    slug: "ai",
    aliases: ["openai-chatgpt"],
    title: "Codex Agent Chat",
    navLabel: "Codex",
    metadataTitle: "AI Agents",
    tagline: "Use Codex where the technical work already lives.",
    summary:
      "Work with Codex alongside your files, notebooks, terminals, screenshots, review notes, and collaborators.",
    metadataSummary:
      "Work with Codex near files, notebooks, terminals, screenshots, patches, review notes, and live notebook state.",
    image: "/public/features/chatgpt-fix-code.png",
    docsUrl: "https://sagemathinc.github.io/cocalc-guides/codex-agent-chat/",
    index: true,
    sections: [
      {
        title: "Codex in project threads",
        paragraphs: [
          "CoCalc-AI uses AI through Codex chat threads. Human @mentions notify collaborators; they do not invoke models.",
        ],
        bullets: [
          "Use OpenAI API keys or OpenAI subscription plans for native Codex support",
          "Keep prompts, images, patches, and review notes in one durable thread",
          "Let Codex work with files, terminals, and live notebook state",
          "Run other command-line agents in project terminals as normal Linux tools",
        ],
      },
    ],
  },
  {
    slug: "whiteboard",
    title: "Whiteboard & Slides",
    navLabel: "Whiteboard",
    metadataTitle: "Whiteboard & Slides",
    tagline: "A collaborative technical canvas for math, code, and sketches.",
    summary:
      "Use an infinite collaborative canvas with markdown, KaTeX, Jupyter cells, multiple pages, and a transparent JSONL document format.",
    metadataSummary:
      "Use collaborative whiteboards and slide-sized pages for markdown, KaTeX math, Jupyter cells, diagrams, presentations, and project context.",
    image: "/public/features/whiteboard-sage.png",
    index: true,
  },
  {
    slug: "slides",
    title: "Slides",
    navLabel: "Slides",
    tagline: "Present from slide-sized technical whiteboards.",
    summary:
      "Build presentation decks from slide-sized whiteboard pages with markdown, math, diagrams, Jupyter cells, collaboration, and project context.",
    metadataSummary:
      "Build presentation decks as a focused part of CoCalc's whiteboards and slides workflow, with markdown, math, diagrams, Jupyter cells, collaboration, and project context.",
    image: "/public/features/whiteboard-sage.png",
    index: false,
  },
  {
    slug: "teaching",
    title: "Teaching a Course",
    navLabel: "Teaching",
    tagline:
      "Run technical courses and labs with shared infrastructure and grading tools.",
    summary:
      "Manage assignments, shared environments, collection, grading, and student help for technical courses and labs.",
    metadataSummary:
      "Organize assignments, distribute files, collect work, and grade notebooks or other project files with a workflow built for technical courses, labs, and training environments.",
    image: "/public/features/cocalc-course-assignments-2019.png",
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
    slug: "exam-scratchpads",
    title: "Computational Exam Scratchpads",
    navLabel: "Exams",
    metadataTitle: "Secure Computational Scratchpads for In-Person Exams",
    tagline:
      "Give every student a clean, temporary notebook environment on dedicated compute.",
    summary:
      "Run browser-based Jupyter and computational scratchpads with a frozen software environment, disabled outbound networking, configurable capacity, and automatic erasure.",
    metadataSummary:
      "CoCalc exam scratchpad hosts provide ephemeral, network-isolated Jupyter projects for in-person university exams on instructor-controlled dedicated compute.",
    docsUrl: "/docs/hosts/exam-scratchpads",
    index: false,
    sections: [
      {
        title: "A calculator, not another assessment platform",
        paragraphs: [
          "Students receive anonymous computational scratch space and copy answers into the institution's existing assessment workflow or onto paper. CoCalc does not require exam questions, student identities, submissions, grading, or proctoring.",
        ],
      },
      {
        title: "Predictable software and capacity",
        bullets: [
          "Freeze one RootFS image and digest for the whole exam",
          "Choose CPU, memory, disk, and maximum simultaneous projects",
          "Use Jupyter, files, kernels, and optionally terminals",
          "Run on an on-demand private host sized for the exam window",
        ],
      },
      {
        title: "Ephemeral by design",
        bullets: [
          "Disable outbound project networking and verify it before admission opens",
          "Disable backups and snapshots for exam projects",
          "Erase every project and its TimeTravel history at the deadline",
          "Automatically power off compute while retaining the reusable host and cached software",
        ],
      },
    ],
  },
  {
    slug: "python",
    title: "Python",
    navLabel: "Python",
    metadataTitle: "Online Python Environment",
    tagline: "A scientific Python environment you can shape yourself.",
    summary:
      "Use Python in Jupyter notebooks, scripts, terminals, JupyterLab, and VS Code, with package installs that persist and larger machines or GPUs when a computation gets heavy.",
    metadataSummary:
      "Use a full Python environment online in your browser: the scientific stack in Jupyter notebooks, .py files and terminals, uv, pip, conda, and apt installs that persist, JupyterLab and VS Code, GPU images for PyTorch and TensorFlow, and Python web apps behind an authenticated URL.",
    image: "/public/features/jupyter-classic-20260817.png",
    index: true,
    sections: [
      {
        title: "A full Python environment online",
        paragraphs: [
          "Run Python online in your browser: every CoCalc project is a Linux machine with the scientific Python stack, so you open a Jupyter notebook, type code, run it, and see the output, with nothing to install on your own computer.",
          "The environment is yours to shape: passwordless sudo, apt-get, uv, pip, and conda all work, and everything you install persists with the project instead of disappearing at the end of a session.",
        ],
        bullets: [
          "Python images ship NumPy, pandas, SciPy, scikit-learn, SymPy, matplotlib, and JupyterLab",
          ".py files with a terminal pane next to the source, Jupyter notebooks, and real Linux terminals",
          "JupyterLab and VS Code launch in the browser from the project's Apps panel",
          "Larger machines and GPUs with CUDA-ready PyTorch and TensorFlow images for heavy runs",
          "Flask, FastAPI, and other Python web apps run behind an authenticated project URL",
        ],
      },
    ],
  },
  {
    slug: "r-statistical-software",
    title: "R Statistical Software",
    navLabel: "R",
    metadataTitle: "R Statistical Software Online",
    tagline: "Use R when statistics is part of a larger project workflow.",
    summary:
      "Work with R in Jupyter notebooks, a browser-based IDE, terminals, scripts, RMarkdown and Quarto documents, knitr LaTeX papers, and shared course projects.",
    metadataSummary:
      "Use R statistical software online in a collaborative CoCalc project: Jupyter notebooks with the IRkernel, a one-click browser-based R IDE, RMarkdown and Quarto reports, knitr LaTeX documents, and persistent package installs.",
    image: "/public/features/cocalc-r-hero-ggplot2-20260731.png",
    index: true,
    sections: [
      {
        title: "R statistical software online",
        paragraphs: [
          "Run R in your browser: Jupyter notebooks with the IRkernel, a full R IDE launched with one click, RMarkdown and Quarto reports, knitr LaTeX documents, and plain R scripts on the command line.",
          "Everything lives in one shared project: data, packages, notebooks, reports, and their full edit history, so collaborators re-run the same analysis instead of a copy.",
        ],
        bullets: [
          "CoCalc renders .Rmd files with rmarkdown::render and .qmd files with quarto render",
          ".Rnw and .Rtex knitr documents build in the LaTeX editor with forward and inverse search",
          "Shiny is installed in the R images, with a bundled example app behind the project proxy",
          "Package installs persist on top of the image's preinstalled R stack",
        ],
      },
    ],
  },
  {
    slug: "julia",
    title: "Julia",
    navLabel: "Julia",
    metadataTitle: "Run Julia Online",
    tagline: "Use Julia in notebooks, terminals, Pluto, and source files.",
    summary:
      "Run Julia in Jupyter notebooks, Pluto, package environments, source files, and terminals.",
    metadataSummary:
      "Run Julia online in a collaborative CoCalc project: the Julia image with its Jupyter kernel, Pluto reactive notebooks, VS Code in the browser, package environments that live with your files, and .jl scripts in a real Linux terminal.",
    image: "/public/features/julia-jupyter.png",
    index: true,
    sections: [
      {
        title: "Run Julia online",
        paragraphs: [
          "Run Julia in your browser without installing anything: start a project on the Julia image and it comes with the Julia Jupyter kernel, Pluto for reactive notebooks, and VS Code in the browser.",
          "Everything sits in one shared project, so data, package environments, notebooks, and their full edit history stay together and collaborators re-run the same code instead of a copy.",
        ],
        bullets: [
          "Julia notebooks with real-time collaboration, cell chat, and TimeTravel history",
          "Pluto reactive notebooks start from the project's Apps panel, with bundled examples",
          "Package environments defined by a Project.toml that lives with your files",
          ".jl files open in the collaborative editor with a one-click julia REPL",
          "Long simulations keep running in a terminal after you close the browser",
        ],
      },
    ],
  },
  {
    slug: "sage",
    title: "SageMath",
    navLabel: "SageMath",
    metadataTitle: "Use SageMath Online",
    tagline:
      "Use SageMath in the collaborative environment with deep roots in Sage.",
    summary:
      "Use SageMath for computational math in notebooks, courses, SageTeX documents, and research.",
    metadataSummary:
      "Use SageMath online without installing anything: SageMath Jupyter notebooks, the sage command line, SageTeX in LaTeX documents, teaching workflows, and long-running computations in a collaborative Linux project.",
    image: "/public/features/sagemath-jupyter.png",
    index: true,
    sections: [
      {
        title: "Use SageMath online",
        paragraphs: [
          "Run SageMath in your browser without installing anything: pick the Sage image and SageMath comes preinstalled, with the Sage Jupyter kernel, the command-line REPL, .sage script support, and SageTeX for LaTeX documents.",
          "The SageMath Jupyter kernel is the default in Sage images, the sage REPL is on the PATH in every terminal, and the LaTeX editor runs the SageTeX pass automatically when a document uses it.",
        ],
        bullets: [
          "SageMath notebooks with real-time collaboration and TimeTravel history",
          "SageTeX: embed live Sage computations in LaTeX papers and handouts",
          "Legacy .sagews worksheets convert to Jupyter notebooks automatically",
          "Teach with Sage: students sign in instead of installing, and nbgrader works with SageMath notebooks",
        ],
      },
    ],
  },
  {
    slug: "octave",
    title: "GNU Octave",
    navLabel: "Octave",
    metadataTitle: "Run GNU Octave Online",
    tagline: "Run Octave online in notebooks, scripts, and terminals.",
    summary:
      "Use GNU Octave for MATLAB-style numerical computing in collaborative projects with notebooks, .m files, terminals, plots, and teaching workflows.",
    metadataSummary:
      "Run GNU Octave online in a CoCalc Linux project: start on the Octave image with its common packages, use Octave as the default Jupyter kernel, edit .m files collaboratively, and keep TimeTravel history and snapshots.",
    image: "/public/features/cocalc-octave-sombrero-20260811.png",
    index: true,
    sections: [
      {
        title: "Run GNU Octave online",
        paragraphs: [
          "GNU Octave is the free numerical computing language that is largely compatible with MATLAB. Start a project on the Octave image and it is ready to use, in a full Linux environment with passwordless sudo, real-time collaboration, TimeTravel history, and snapshots.",
          "Octave is the default Jupyter kernel on that image, .m files open in the collaborative editor with Octave syntax highlighting, and scripts run in a terminal that survives disconnects.",
        ],
        bullets: [
          "Octave built from source with the statistics, control, signal, image, optim, and symbolic packages",
          "Jupyter kernels for Octave and Python, plus JupyterLab from the project's Apps panel",
          ".m files open in the collaborative editor with a one-click octave shell",
          "Real-time collaboration, TimeTravel history, and snapshots in every project",
        ],
      },
    ],
  },
  {
    slug: "api",
    title: "HTTP API",
    navLabel: "API",
    tagline: "Drive CoCalc projects from your own scripts and pipelines.",
    summary:
      "A documented HTTP API to create projects and run notebooks, terminals, and computations from your own code — results land back in the project.",
    metadataSummary:
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
    navLabel: "Compare",
    tagline: "A concise view of what CoCalc bundles into one workspace.",
    summary:
      "Compare when CoCalc's shared project model is a better fit than a single notebook, dashboard, or editor.",
    metadataSummary:
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

const PUBLIC_FEATURE_PAGE_MAP = new Map<string, PublicFeaturePage>();

for (const page of PUBLIC_FEATURE_PAGES) {
  PUBLIC_FEATURE_PAGE_MAP.set(page.slug, page);
  for (const alias of page.aliases ?? []) {
    PUBLIC_FEATURE_PAGE_MAP.set(alias, page);
  }
}

export function getPublicFeaturePage(
  slug?: string,
): PublicFeaturePage | undefined {
  if (!slug) return;
  return PUBLIC_FEATURE_PAGE_MAP.get(slug);
}

export function getPublicFeatureIndexPages(): PublicFeaturePage[] {
  return PUBLIC_FEATURE_PAGES.filter((page) => page.index);
}

// The feature sub-navigation (side-rail pills on the feature pages and the
// "Features" dropdown in the public top nav), derived from the page
// definitions above: every page with a navLabel, in definition order.
export const PUBLIC_FEATURE_NAV_ITEMS: ReadonlyArray<{
  label: string;
  slug: string;
}> = PUBLIC_FEATURE_PAGES.filter((page) => page.navLabel != null).map(
  (page) => ({ label: page.navLabel!, slug: page.slug }),
);
