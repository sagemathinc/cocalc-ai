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

// Accept unprefixed catalog links authored relative to the site root, not
// URLs already resolved for a deployment. A catalog path may itself start with
// the deployment prefix. Preserve external URLs, queries, and fragments.
export function publicFeatureHref(
  catalogHref: string,
  basePath: string,
): string {
  if (!catalogHref.startsWith("/") || catalogHref.startsWith("//")) {
    return catalogHref;
  }
  return `${basePath.replace(/\/+$/, "")}${catalogHref}`;
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
      "Run collaborative Jupyter notebooks with cell chat, TimeTravel history, course workflows, and AI agent tools. Select a local or remote kernel with the language and packages your analysis needs.",
    image: "/public/features/cocalc-jupyter2-20170508.png",
    index: true,
    sections: [
      {
        title: "Run Jupyter notebooks online",
        paragraphs: [
          "Use hosted Jupyter notebooks without installing the hosted runtime on your computer. Computations can continue after you close a tab while their kernel runtime remains running.",
          "Choose an image, custom kernel, or registered remote kernel with the required language and packages. Native CoCalc Plus uses installed local tools; collaborators share the selected notebook kernel session.",
        ],
        bullets: [
          "Real-time collaborative editing with visible cursors and shared kernel sessions",
          "Chat threads anchored to individual cells, plus TimeTravel edit history",
          "Course workflows for distributing, collecting, and grading notebook assignments",
          "CPU and memory gauges inform interrupt or restart decisions; save intermediate results before long runs",
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
      "Write LaTeX online with collaboration, PDF preview, source synchronization, anchored discussions and edit history. Use SageTeX, PythonTeX and Knitr when their tools are installed in the project.",
    image: "/public/features/latex-editor-main-20251003.png",
    index: true,
    sections: [
      {
        title: "Write LaTeX online",
        paragraphs: [
          "Edit LaTeX alongside its compiled PDF, use Sync to move from source to output, and inspect build diagnostics. Build on save and automatic source-to-PDF synchronization follow your editor settings.",
          "Collaborators edit the same document in real time, discussions attach to specific lines, and TimeTravel provides document edit history. Rich text widgets preview supported constructs; check the compiled PDF for final layout.",
        ],
        bullets: [
          "Use a hosted image with the required TeX tools, or install the tools for local CoCalc Plus",
          "Knitr, SageTeX, and PythonTeX builds require the corresponding language runtimes and packages",
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
    tagline: "A collaborative shell beside your project files.",
    summary:
      "Work in a shared Linux shell with tools and files near notebooks, documents, and project history.",
    metadataSummary:
      "Use a hosted Linux terminal beside project files, notebooks, and collaborators. Reconnect to live shell sessions while the project runtime remains running.",
    image: "/public/features/terminal.png",
    index: true,
    sections: [
      {
        title: "A real Linux terminal online",
        paragraphs: [
          "Use a hosted project shell from your browser, with commands and software provided by the selected image and your project installs.",
          "Collaborators can share a live shell and reconnect after a browser disconnect while the project runtime remains running. Stops, restarts, failures, and configured browser-idle timeouts end running processes.",
        ],
        bullets: [
          "Run commands and scripts in the same project as notebooks and documents",
          "Install packages with tools supported by the selected image and interpreter, using persistent project storage",
          "Edit a script and run it in a terminal pane right next to the editor",
          "Save logs and checkpoints so interrupted jobs can resume",
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
      "Use a hosted Linux environment with collaborative editors and terminals, project storage, SSH, and web apps. Choose an image and check its software and storage policies.",
    image: "/public/features/cocalc-shell-script-run.png",
    index: true,
    sections: [
      {
        title: "A complete Linux environment online",
        paragraphs: [
          "Hosted projects provide a Linux environment. CoCalc Basic includes Ubuntu tools such as bash, Git, curl, and Python; other images can provide different packages and package managers.",
          "On images with sudo enabled, passwordless sudo installs packages inside the project container, not on its host machine. Installs in persistent home or writable system storage survive normal restarts and are included in project backups and moves.",
        ],
        bullets: [
          "Persistent home directory, configurable snapshot retention, and completed off-host backup recovery points",
          "Inspect detected HTTP apps and configure their readiness, base path, and proxy settings",
          "SSH, scp, sftp, and rsync access, including project-to-project SSH",
          "Inspect memory and CPU usage, then check access, compatible hardware, and backup freshness before a host move",
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
      "Run Linux GUI applications in a shared project with compatible graphical support, clipboard permissions, sound, and application launchers.",
    metadataSummary:
      "Stream Wayland and X11 application windows from a Linux project with graphical support. Share a live display, use browser clipboard permissions and PipeWire audio, and choose compatible launchers.",
    docsUrl: "/app-docs/terminal/graphical-applications",
    index: true,
    sections: [
      {
        title: "Linux GUI applications in the browser",
        paragraphs: [
          "In a Linux project with graphical support installed, open an .x11 file and launch Wayland or X11 applications. Automatic dependency installation needs compatible package tools and sudo permissions.",
          "CoCalc embeds Blit's headless Wayland compositor and uses xwayland-satellite for X11 compatibility, so applications appear as focused browser surfaces instead of inside a traditional remote desktop.",
        ],
        bullets: [
          "Browser clipboard and PipeWire application audio",
          "Install-on-demand launchers and a ready-made X11 software environment",
          "One shared live display; stopping the project or graphical app ends its running applications",
          "Check DISPLAY in the running graphical terminal before launching X11 programs from another terminal or notebook in the same project runtime",
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
      "Choose an available image for a hosted CoCalc project, from a lean base to a scientific stack. Check included software, customize persistent storage, and record versions for reruns.",
    index: true,
    sections: [
      {
        title: "Pick the software, keep your changes",
        paragraphs: [
          "Hosted CoCalc projects use runtime images. Check the catalog entry for included languages, kernels, apps, version, and compatible hardware; choosing a GPU image does not provide GPU hardware.",
          "Installs in persistent home or writable system storage survive normal restarts. Publish a configured system environment for a team or course, preserving research data separately from the image.",
        ],
        bullets: [
          "Check catalog software, versions, and release channels before selecting an image",
          "Changing a running project's image queues a restart; one previous image is retained for rollback",
          "Build custom images from a declarative recipe or a Binder-style repository",
          "Managed base-image layers do not use project disk quota; writable project files and changes do",
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
      "Use a collaborative canvas with markdown, KaTeX, Jupyter cells, multiple pages and JSONL documents. Run connected code cells as a rooted tree with an available kernel.",
    metadataSummary:
      "Use collaborative whiteboards for math, diagrams and Jupyter cells. Run Tree follows a rooted code-cell tree; TimeTravel reviews document history rather than restoring live kernel state.",
    image: "/public/features/whiteboard-sage.png",
    index: true,
  },
  {
    slug: "slides",
    title: "Slides",
    navLabel: "Slides",
    tagline: "Present from slide-sized technical whiteboards.",
    summary:
      "Build editable decks from slide-sized whiteboard pages with markdown, math, diagrams and Jupyter cells. Running code needs an available kernel; shared previews show stored content.",
    metadataSummary:
      "Present collaborative technical slides in a project with markdown, math, diagrams and Jupyter cells, and use an available kernel for live code execution.",
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
      "Use Python in Jupyter notebooks, scripts, terminals, JupyterLab, and VS Code. Choose an environment and available compute for your workload.",
    metadataSummary:
      "Use Python online with Jupyter notebooks, scripts, terminals, and web apps. Select and verify the environment used by each tool; use compatible hosted GPU resources where available.",
    image: "/public/features/jupyter-classic-20260817.png",
    index: true,
    sections: [
      {
        title: "A full Python environment online",
        paragraphs: [
          "Hosted CoCalc projects run the software supplied by their selected Linux image. Choose a Python image for scientific work; local CoCalc Plus uses your computer's operating system and installed software.",
          "Install dependencies in the intended environment using the tools and permissions available. Record versions and install locations, and check HOME and RootFS retention before relying on a restore or move.",
        ],
        bullets: [
          "Python images ship NumPy, pandas, SciPy, scikit-learn, SymPy, matplotlib, and JupyterLab",
          ".py files with a terminal pane next to the source, Jupyter notebooks, and real Linux terminals",
          "With the required software installed, JupyterLab and VS Code launch from Apps and can select their own Python environment",
          "Choose available hosted capacity and verify GPU access from the selected kernel before training",
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
      "Use R online in a collaborative project. Choose an image with the R kernel, IDE, and document tools needed for notebooks, RMarkdown, Quarto, knitr, or scripts.",
    image: "/public/features/cocalc-r-hero-ggplot2-20260731.png",
    index: true,
    sections: [
      {
        title: "R statistical software online",
        paragraphs: [
          "Select an R environment with the required tools, then use its notebook kernel, IDE launcher, document renderer, or terminal for the task.",
          "Keep data, package requirements, notebooks, and reports in the same project. Record versions and checked outputs for reruns; TimeTravel covers supported collaborative editors, not every filesystem change.",
        ],
        bullets: [
          "CoCalc renders .Rmd files with rmarkdown::render and .qmd files with quarto render",
          ".Rnw and .Rtex knitr documents build in the LaTeX editor with forward and inverse search",
          "Images with Shiny and its bundled example offer a project app through the authenticated proxy",
          "Installs in persistent project storage survive normal restarts; running jobs need logs and checkpoints",
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
          "Keep data, notebooks, and environment records in the shared project. Collaborators should verify the Julia version and active environment before comparing results.",
        ],
        bullets: [
          "Julia notebooks with real-time collaboration, cell chat, and TimeTravel history",
          "Pluto reactive notebooks start from the project's Apps panel, with bundled examples",
          "Keep Project.toml and Manifest.toml with the analysis to record dependencies and resolved versions",
          ".jl files open in the collaborative editor with a one-click julia REPL",
          "Terminal computations can continue after browser disconnect while the project runtime remains running",
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
      "Use a hosted Sage image for collaborative notebooks, the sage command line and teaching. SageTeX needs matching TeX tools; long computations also need a running project runtime.",
    image: "/public/features/sagemath-jupyter.png",
    index: true,
    sections: [
      {
        title: "Use SageMath online",
        paragraphs: [
          "Choose a hosted Sage image with its Sage Jupyter kernel, command-line REPL and .sage support. Native CoCalc Plus uses the software installed on your computer. Check the image, Sage version and additional packages before reproducing a calculation.",
          "Sage images select the SageMath kernel by default. With Sage and compatible TeX tools installed, the LaTeX build pipeline can run the SageTeX stage. Inspect the build logs and PDF after changes.",
        ],
        bullets: [
          "SageMath notebooks with real-time collaboration and TimeTravel history",
          "SageTeX: embed live Sage computations in LaTeX papers and handouts",
          "Legacy .sagews opening can reuse an existing notebook; conversion creates source cells without historical outputs",
          "Configure student Sage environments and choose the nbgrader grading location and dependencies",
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
      "Use an available hosted Octave image for notebooks, .m files, terminals and collaboration. Check package requirements, installation locations and configured backup coverage.",
    image: "/public/features/cocalc-octave-sombrero-20260811.png",
    index: true,
    sections: [
      {
        title: "Run GNU Octave online",
        paragraphs: [
          "GNU Octave provides largely MATLAB-compatible numerical computing. A hosted Octave image supplies the tools, while system installation permissions and snapshot coverage depend on the image and deployment. Native CoCalc Plus uses installed local software.",
          "Octave is the default Jupyter kernel on the Octave image, and .m files open with Octave syntax highlighting. Terminal work can continue after a browser disconnect while its project runtime remains running.",
        ],
        bullets: [
          "Octave built from source with the statistics, control, signal, image, optim, and symbolic packages",
          "Jupyter kernels for Octave and Python, plus JupyterLab from the project's Apps panel",
          ".m files open in the collaborative editor with a one-click octave shell",
          "Collaborative editing and document history, with backup coverage checked for the project and file locations",
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
      "Use documented HTTP endpoints for targeted integrations, and the CoCalc CLI for richer project, notebook, terminal, and host workflows.",
    metadataSummary:
      "Use the CoCalc HTTP API for automation, integration, and provisioning workflows without depending on the web UI.",
    image: "/public/features/api-screenshot.png",
    index: true,
    sections: [
      {
        title: "Use cases",
        bullets: [
          "Call documented endpoints available on your deployment",
          "Use scoped credentials and the permissions required by each operation",
          "Save result artifacts independently of returned command output",
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
  config?: { cocalc_product?: string },
): PublicFeaturePage | undefined {
  if (!slug) return;
  const page = PUBLIC_FEATURE_PAGE_MAP.get(slug);
  // Omitted config is the authoring catalog. Renderers supply config even
  // before the product is known, so unavailable compute links stay hidden.
  if (
    page?.slug === "research-compute" &&
    config !== undefined &&
    config.cocalc_product !== "launchpad" &&
    config.cocalc_product !== "rocket"
  ) {
    return;
  }
  return page;
}

export function getPublicFeatureIndexPages(config?: {
  cocalc_product?: string;
}): PublicFeaturePage[] {
  return PUBLIC_FEATURE_PAGES.filter(
    (page) => page.index && getPublicFeaturePage(page.slug, config) != null,
  );
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
