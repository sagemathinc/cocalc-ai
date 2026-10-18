/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Words of the Where to run CoCalc page (/products), the product pages under
// it, and the lines on other public pages that name or describe a product.
// The React pages and the crawler fallback in
// hub/servers/app/public-prerender.ts both render these strings, so the two
// stay word for word the same. Which products appear depends only on the
// switches in public-product-availability; a hidden product's copy stays
// here, to be updated before it returns.

import {
  getPublicProduct,
  isPublicProductShown,
  type PublicProductId,
  shownPublicProductNames,
} from "./public-product-availability";
import { CANONICAL_PUBLIC_SITE_ORIGIN } from "./public-site-policy";

// A link on a product page: a path relative to the site's base path, a
// fragment on the same page, or an absolute URL.
export interface PublicProductLink {
  href: string;
  label: string;
  primary?: boolean;
}

export interface PublicProductPoint {
  body: string;
  title: string;
}

// A command to copy and run, shown in a code block; `label` names the block
// for screen readers.
export interface PublicProductCommand {
  code: string;
  label: string;
}

// One block of a card, in the order the card shows them: a paragraph, where
// text between backticks is code such as a path or an address; a paragraph
// of text and links; a caveat, in muted text on the page; or a command.
export type PublicProductBlock =
  | string
  | { text: readonly (string | PublicProductLink)[] }
  | { note: string }
  | PublicProductCommand;

// A run of a paragraph, as both renderers show it.
export type PublicProductTextPart =
  | { text: string }
  | { code: string }
  | { link: PublicProductLink };

// The runs of a paragraph block, in order: text, code and links.
export function publicProductTextParts(
  block: string | { text: readonly (string | PublicProductLink)[] },
): PublicProductTextPart[] {
  const runs = typeof block === "string" ? [block] : block.text;
  return runs.flatMap((run): PublicProductTextPart[] =>
    typeof run === "string"
      ? run
          .split("`")
          .flatMap((part, index) =>
            part === "" ? [] : [index % 2 ? { code: part } : { text: part }],
          )
      : [{ link: run }],
  );
}

// Titled text in one of the page's cards: its blocks, then links. `key` names
// the card that shows it on the React page.
export interface PublicProductSection {
  blocks: readonly PublicProductBlock[];
  key: string;
  links?: readonly PublicProductLink[];
  title: string;
}

export interface PublicProductPageCopy {
  // The first section: its heading, paragraphs and actions.
  lead: {
    actions: readonly PublicProductLink[];
    paragraphs: readonly string[];
    title: string;
  };
  // Resource links at the end of the page.
  links: readonly PublicProductLink[];
  // The product's boundary, and when to choose another path, under
  // `notesTitle`. These name only products the public pages show.
  notes: readonly string[];
  notesTitle: string;
  // The positioning cards under the first section.
  points: readonly PublicProductPoint[];
  sections: readonly PublicProductSection[];
}

// "A", "A or B", "A, B, or C".
export function joinPublicList(
  items: readonly string[],
  conjunction: "and" | "or",
): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, ${conjunction} ${
    items[items.length - 1]
  }`;
}

// A prefilled request to the sales and support team, relative to the site's
// base path.
export function publicProductContactPath({
  body,
  context,
  subject,
  title,
}: {
  body: string;
  context: string;
  subject: string;
  title: string;
}): string {
  const params = new URLSearchParams({
    body,
    context,
    subject,
    title,
    type: "purchase",
  });
  return `support/new?${params.toString()}`;
}

// "View CoCalc Star", for each shown product among `ids`.
function viewProductActions(
  ids: readonly PublicProductId[],
): PublicProductLink[] {
  return ids
    .filter((id) => isPublicProductShown(id))
    .map((id) => {
      const { name, slug } = getPublicProduct(id);
      return { href: `products/${slug}`, label: `View ${name}` };
    });
}

export const PUBLIC_PRODUCTS_PAGE_LINK: PublicProductLink = {
  href: "products",
  label: "Where to run CoCalc",
};

const PRICING_LINK: PublicProductLink = {
  href: "pricing",
  label: "Pricing and licensing",
};

const COCALC_AI_START_LINK: PublicProductLink = {
  href: `${CANONICAL_PUBLIC_SITE_ORIGIN}/pricing`,
  label: "Start on CoCalc.ai",
};

// The guide to setting up Codex access, which the Star page and the
// comparison on Where to run CoCalc link.
export const PUBLIC_CONNECT_AI_ACCESS_LINK: PublicProductLink = {
  href: "docs/ai/connect-credentials",
  label: "Connect AI access",
};

// The CoCalc Plus installer. It installs the current release for your user,
// and the page's command and its "Open install script" link both come from
// here.
export const PUBLIC_PLUS_INSTALL_SCRIPT_URL =
  "https://software.cocalc.ai/software/plus/install.sh";

export const PUBLIC_PLUS_INSTALL_COMMAND = `curl -fsSL ${PUBLIC_PLUS_INSTALL_SCRIPT_URL} | sh`;

// Removes the install folder and the launcher that the installer creates, at
// their default locations. CoCalc Plus keeps its data in a folder of its own,
// which stays.
export const PUBLIC_PLUS_UNINSTALL_COMMAND =
  "rm -rf ~/.local/share/cocalc/plus ~/.local/bin/cocalc-plus";

// The Launchpad installer that this hidden page names still installs the
// 2026-07-01 builds. Update this command, and the install script and
// software page links on the Launchpad page, to the current installer when
// Launchpad returns.
export const PUBLIC_LAUNCHPAD_INSTALL_COMMAND =
  "curl -fsSL https://software.cocalc.ai/software/cocalc-launchpad/install.sh | bash";

// One-line commands: they work unchanged in macOS and Linux terminals and in
// Windows PowerShell, where backslash line continuations do not.
export const PUBLIC_STAR_INSTALL_COMMAND =
  "docker run -d --name cocalc-star --restart unless-stopped --privileged --cgroupns=host -v cocalc-star:/var/lib/cocalc -p 8170:80 -e COCALC_STAR_HTTP_PORT=8170 sagemathinc/star";

const STAR_SERVER_COMMAND =
  "docker run -d --name cocalc-star --restart unless-stopped --privileged --cgroupns=host -v cocalc-star:/var/lib/cocalc -p 443:443 -p 80:80 -e COCALC_STAR_DOMAIN=star.example.com sagemathinc/star";

export const PUBLIC_STAR_REMOVE_COMMANDS =
  "docker rm -f cocalc-star\ndocker volume rm cocalc-star\ndocker rmi sagemathinc/star";

const STAR_CONTACT_PATH = publicProductContactPath({
  body: "I want to talk with CoCalc about CoCalc Star. Helpful context: who will use it, where it runs, whether a larger private deployment is part of the decision, and support expectations.",
  context: "product-cocalc-star",
  subject: "CoCalc Star",
  title: "Talk with CoCalc about Star",
});

function starPage(): PublicProductPageCopy {
  const privatePaths = shownPublicProductNames(["launchpad", "rocket"], {
    short: true,
  });
  return {
    lead: {
      actions: [
        {
          href: "#install-cocalc-star",
          label: "Install CoCalc Star",
          primary: true,
        },
        { href: STAR_CONTACT_PATH, label: "Talk with us" },
        ...viewProductActions(["launchpad", "rocket"]),
      ],
      paragraphs: [
        "CoCalc Star is free of charge. SageMath, Inc. publishes it on Docker Hub as sagemathinc/star. You run Star on your own computer or server, and you are responsible for operating it, including upgrades and backups. For a larger private deployment, or for support, talk with us.",
      ],
      // Price and operating facts only: the lead does not say whom Star is
      // for.
      title: "Your agents, on one machine you control.",
    },
    links: [
      {
        href: "https://hub.docker.com/r/sagemathinc/star",
        label: "Docker Hub",
      },
      {
        href: "docs/self-hosting/cocalc-star",
        label: "Read Star setup guide",
      },
    ],
    notes: [
      "Star is one machine: it is not a high-availability or scale-out deployment.",
      ...(privatePaths.length > 0
        ? [
            `Use ${joinPublicList(privatePaths, "or")} when private deployment or institutional rollout is the real decision.`,
          ]
        : []),
    ],
    notesTitle: "Boundary: one machine",
    points: [
      {
        body: "Star is for people you invite: signing up requires a registration link.",
        title: "Who can sign up",
      },
      {
        body: "One Docker container and one Docker volume on macOS, Windows, or Linux. Every project runs in its own isolated container inside it.",
        title: "How it runs",
      },
      {
        body: "Free. Upgrades are a new image, and removing the container and volume removes all of its data.",
        title: "Easy to try, easy to undo",
      },
    ],
    sections: [
      // Only what is confirmed for Star: other agent runtimes are not named
      // until a check on a fresh container passes.
      {
        blocks: [
          // Codex on Star also accepts another kind of credential
          // (project-host/codex/codex-auth.ts). The public pages name only
          // the OpenAI API key and the site key, here and in the comparison
          // below.
          "Codex is on by default in CoCalc Star. Each person connects their own OpenAI API key, or an administrator sets a site key.",
          "Every project has internet access, so agents can install the packages they need.",
        ],
        key: "agents",
        links: [PUBLIC_CONNECT_AI_ACCESS_LINK],
        title: "Agents on Star",
      },
      {
        blocks: [
          {
            text: [
              "1. Install ",
              {
                href: "https://www.docker.com/products/docker-desktop/",
                label: "Docker Desktop",
              },
              " on macOS or Windows, or Docker Engine with cgroup v2 on Linux, and start it. Give Docker at least 4 CPUs and 16 GB of memory, with at least 50 GB of free disk space for its volume.",
            ],
          },
          {
            note: "With Docker Desktop on Windows, and on Linux kernels older than 6.7, projects share the volume's disk space without per-project quotas.",
          },
          "2. Run this in a terminal (on Windows, in PowerShell):",
          { code: PUBLIC_STAR_INSTALL_COMMAND, label: "Install command" },
          "3. Follow the first start, which takes a few minutes:",
          {
            code: "docker logs -f cocalc-star",
            label: "Follow the first start",
          },
          "When it prints a link starting with `http://localhost:8170`, open it to create your admin account.",
        ],
        key: "install",
        title: "Install CoCalc Star",
      },
      {
        blocks: [
          "Try Star on your laptop, or run it on a Linux server with a DNS name so the people you invite can reach it.",
          "Point a DNS name at a Linux server with Docker and open port 443, then run the same command with your domain. HTTPS certificates are obtained and renewed automatically.",
          { code: STAR_SERVER_COMMAND, label: "Server install command" },
          "Lost the admin link, or someone else used it? Create a new one:",
          {
            code: "docker exec cocalc-star star admin-link",
            label: "New admin link",
          },
        ],
        key: "server",
        title: "On a server with a domain",
      },
      {
        blocks: [
          "All accounts, projects, settings, and certificates live in the `cocalc-star` volume. To upgrade, replace the container:",
          {
            code: "docker pull sagemathinc/star\ndocker rm -f cocalc-star\n# then run the same docker run command you installed with",
            label: "Upgrade commands",
          },
          "Running projects stop during the upgrade and can be started again right away.",
        ],
        key: "upgrade",
        title: "Upgrade",
      },
      {
        blocks: [
          "Star writes no files outside Docker. This deletes CoCalc Star and all of its data:",
          { code: PUBLIC_STAR_REMOVE_COMMANDS, label: "Remove commands" },
          "On Linux hosts with AppArmor, a small kernel profile for Star's bundled container runtime stays loaded until the host restarts; the setup guide shows how to unload it sooner.",
        ],
        key: "remove",
        title: "Remove it completely",
      },
    ],
  };
}

// CoCalc Plus as its installer ships it (release 1792043311, version 0.2.90):
// builds for Linux on x64 and ARM64 with glibc, and for Apple silicon Macs; an
// install for one user that keeps itself up to date and keeps its data folder
// when it is removed; and Codex through the Codex CLI that the user installs.
// The page states no price. Check every fact here against the release it
// describes when the installer changes.
function plusPage(): PublicProductPageCopy {
  const sharedPaths = shownPublicProductNames(["star", "launchpad", "rocket"], {
    short: true,
  });
  return {
    lead: {
      actions: [
        {
          href: "#install-cocalc-plus",
          label: "Install CoCalc Plus",
          primary: true,
        },
        COCALC_AI_START_LINK,
        PRICING_LINK,
        ...viewProductActions(["star"]),
      ],
      paragraphs: [
        "CoCalc Plus runs CoCalc on your own computer, for your own projects. Codex works through the Codex CLI you install, with your own OpenAI API key.",
      ],
      title: "Your own CoCalc, on your own computer.",
    },
    // The install, update and uninstall steps are on the page itself.
    links: [],
    notes: [
      "Plus is for local evaluation or individual work on one machine.",
      "It is self-serve local software; the user operates the runtime and local data.",
      "Named agents and sharing, Claude, sensors, and snapshots and backups are on CoCalc.ai.",
      "Use hosted CoCalc.ai when collaborators need shared projects operated by CoCalc.",
      ...(sharedPaths.length > 0
        ? [
            `Use ${joinPublicList(sharedPaths, "or")} when the group needs a shared deployment.`,
          ]
        : []),
    ],
    notesTitle: "Boundary: local, one-user runtime",
    points: [
      {
        body: "One person working in CoCalc on their own computer, with their local files and installed tools.",
        title: "Who it fits",
      },
      {
        body: "Runs on one computer, a Linux machine (x64 or ARM64, with glibc) or an Apple silicon Mac, and is operated by the user. It is the local, one-user runtime in the product family.",
        title: "How it runs",
      },
      {
        body: "Use Plus for local evaluation, demos, personal projects, and learning the CoCalc project model without creating a hosted account.",
        title: "When to choose it",
      },
    ],
    sections: [
      {
        blocks: [
          "On Linux (x64 or ARM64, with glibc) or an Apple silicon Mac, run this in a terminal:",
          { code: PUBLIC_PLUS_INSTALL_COMMAND, label: "Install command" },
          "By default it installs CoCalc Plus for your user in `~/.local/share/cocalc/plus`, with the `cocalc-plus` launcher in `~/.local/bin`, which it adds to your PATH if needed. Then start it with `cocalc-plus`.",
          {
            note: "On Linux, CoCalc Plus needs libatomic.so.1 (the libatomic1 package on Debian or Ubuntu, libatomic on Fedora or RHEL); the installer says so if it is missing.",
          },
        ],
        key: "install",
        links: [
          {
            href: PUBLIC_PLUS_INSTALL_SCRIPT_URL,
            label: "Open install script",
          },
        ],
        title: "Install CoCalc Plus locally",
      },
      {
        blocks: [
          "Codex works in chat, with your local files and installed tools.",
          "You choose how much Codex may change: Read only, Workspace write (the default) or Full access.",
          "Other command-line agents can run in a terminal. Requests from Codex and from these agents leave your computer.",
        ],
        key: "agents",
        title: "Agents on Plus",
      },
      {
        blocks: [
          "CoCalc Plus keeps itself up to date: while it runs, it installs new releases in the background, and each takes effect the next time CoCalc Plus starts. To install the newest release now, run:",
          { code: "cocalc-plus update", label: "Update command" },
        ],
        key: "update",
        title: "Updates",
      },
      {
        blocks: [
          "To remove CoCalc Plus, delete its install folder and its launcher:",
          { code: PUBLIC_PLUS_UNINSTALL_COMMAND, label: "Uninstall command" },
          "These are the default locations. If `XDG_DATA_HOME` was set when you installed CoCalc Plus, its install folder is `$XDG_DATA_HOME/cocalc/plus`; if `XDG_BIN_HOME` was set, its launcher is `$XDG_BIN_HOME/cocalc-plus`.",
          "If the installer added the launcher's folder to your PATH, also remove the line it appended to your shell's startup file: `~/.zshrc`, `~/.bashrc`, `~/.config/fish/config.fish` or `~/.profile`.",
          "Uninstalling keeps your CoCalc Plus data, in `~/.local/share/cocalc-plus/data` on Linux or `~/Library/Application Support/cocalc-plus/data` on a Mac.",
        ],
        key: "uninstall",
        title: "Uninstall",
      },
    ],
  };
}

const LAUNCHPAD_CONTACT_PATH = publicProductContactPath({
  body: "I want to talk with CoCalc about CoCalc Launchpad. Helpful context: expected users or projects, pilot/lab/workshop/department scope, operating environment, who will own infrastructure, recovery, and ongoing operations, timeline, support expectations, and whether pricing, site licensing, data-location, privacy, or security questions are part of the decision.",
  context: "product-cocalc-launchpad",
  subject: "CoCalc Launchpad",
  title: "Talk with CoCalc about Launchpad",
});

const ROCKET_CONTACT_PATH = publicProductContactPath({
  body: "I want to talk with CoCalc about CoCalc Rocket. Helpful context: organization type, expected users or projects, private-cloud requirements, infrastructure constraints, and timeline.",
  context: "product-cocalc-rocket",
  subject: "CoCalc Rocket",
  title: "Talk with CoCalc about Rocket",
});

// CoCalc Launchpad, for when its release is current again. Confirm every fact
// here against the returning release.
function launchpadPage(): PublicProductPageCopy {
  return {
    lead: {
      actions: [
        {
          href: LAUNCHPAD_CONTACT_PATH,
          label: "Talk with CoCalc about Launchpad",
          primary: true,
        },
        {
          href: "#install-cocalc-launchpad",
          label: "Review Launchpad installer",
        },
        PRICING_LINK,
        ...viewProductActions(["star"]),
      ],
      paragraphs: [
        "CoCalc Launchpad runs a private CoCalc site for a small group, on infrastructure your team operates. Running Launchpad for an organization requires a license agreement with SageMath, Inc.; talk with us before you deploy.",
      ],
      title: "Run CoCalc for your team on infrastructure you operate.",
    },
    links: [],
    notes: [
      "Launchpad is customer-operated and sized for a pilot, lab, workshop, department, or platform team.",
      "The customer or administrator owns infrastructure, recovery, and ongoing operations.",
      ...(isPublicProductShown("star")
        ? ["Use Star if one machine running Docker is enough."]
        : []),
      ...(isPublicProductShown("rocket")
        ? [
            "Use Rocket when governance, support, and broader private-cloud planning are the main decision.",
          ]
        : []),
    ],
    notesTitle: "Boundary: bounded private deployment",
    points: [
      {
        body: "Small groups of up to about 25 users, such as a workshop, lab, or department, whose own IT or operations team runs CoCalc with project hosts it provides.",
        title: "Who it fits",
      },
      {
        body: "A lightweight private CoCalc site, where people and Codex agents work in shared projects on the project hosts you run. It gives operators more control over the environment than Star.",
        title: "How it runs",
      },
      {
        body: "Use Launchpad when a hosted account is not the right fit and a single public-VM appliance is too constrained for the pilot or department.",
        title: "When to choose it",
      },
    ],
    sections: [
      {
        blocks: [
          "For operator setup, copy and run this in your terminal:",
          { code: PUBLIC_LAUNCHPAD_INSTALL_COMMAND, label: "Install command" },
          "Current supported targets are Linux on x64 or arm64, and macOS on arm64.",
        ],
        key: "install",
        // Both links are to the installer that serves the 2026-07-01 builds:
        // update them, as PUBLIC_LAUNCHPAD_INSTALL_COMMAND, when Launchpad
        // returns.
        links: [
          {
            href: "https://software.cocalc.ai/software/cocalc-launchpad/install.sh",
            label: "Open install script",
          },
          {
            href: "https://software.cocalc.ai/software/cocalc-launchpad/index.html",
            label: "Open software page",
          },
        ],
        title: "Install CoCalc Launchpad",
      },
    ],
  };
}

// CoCalc Rocket, for when it has a current release. Confirm every fact here
// against that release.
function rocketPage(): PublicProductPageCopy {
  return {
    lead: {
      actions: [
        {
          href: ROCKET_CONTACT_PATH,
          label: "Talk with CoCalc about Rocket",
          primary: true,
        },
        PRICING_LINK,
      ],
      paragraphs: [
        "CoCalc Rocket is for larger private-cloud deployments. Licensing, support and deployment terms are agreed with SageMath, Inc. before rollout.",
      ],
      title: "Planning an institutional private CoCalc deployment?",
    },
    links: [],
    notes: [
      "Rocket starts with a deployment and commercial conversation, not a self-service installer.",
      "It is for customer-operated private-cloud planning with infrastructure, governance, support requirements, and clear ownership of ongoing operations.",
      ...(isPublicProductShown("launchpad")
        ? [
            "Use Launchpad when the immediate need is a smaller bounded private deployment.",
          ]
        : []),
    ],
    notesTitle: "Boundary: planned private cloud",
    points: [
      {
        body: "Industry R&D organizations, research and national labs, enterprises, and government teams planning a broader customer-operated CoCalc deployment with governance, procurement, support, and rollout requirements.",
        title: "Who it fits",
      },
      {
        body: "Runs on customer-operated infrastructure, where people and Codex agents work in shared projects on project hosts. The source includes a systemd/VM bay runtime bundle and a minimal Kubernetes Helm chart. Neither is a tested installation for your environment; CoCalc adapts it with you.",
        title: "How it runs",
      },
      {
        body: "Use Rocket when the deployment decision includes private infrastructure, capacity planning, operational ownership, support expectations, and commercial terms.",
        title: "When to choose it",
      },
    ],
    sections: [
      {
        blocks: [
          "Start with support when the decision includes infrastructure, rollout, governance, site licensing, or deployment-planning expectations.",
        ],
        key: "plan",
        links: [
          ...viewProductActions(["launchpad"]),
          PUBLIC_PRODUCTS_PAGE_LINK,
        ],
        title: "Plan Rocket with CoCalc",
      },
    ],
  };
}

const PRODUCT_PAGES: Record<PublicProductId, () => PublicProductPageCopy> = {
  launchpad: launchpadPage,
  plus: plusPage,
  rocket: rocketPage,
  star: starPage,
};

// A product page's words. Read at render time: the notes and actions name only
// products the public pages show.
export function getPublicProductPageCopy(
  id: PublicProductId,
): PublicProductPageCopy {
  return PRODUCT_PAGES[id]();
}

// The note after the first section of every product page: its title in bold,
// then its body.
export const PUBLIC_PRODUCT_SHARED_NOTE = {
  body: "The product path changes where CoCalc runs and who operates it. Files, notebooks, and terminals stay organized around a project; collaboration, history, recovery, and agent features depend on the product and deployment configuration.",
  title: "One project model, different operating paths.",
} as const;

// One line per path on the products page, in the order the page lists them.
export const PUBLIC_PRODUCT_PATH_DETAILS: Record<PublicProductId, string> = {
  launchpad:
    "A bounded private deployment for a pilot, lab, workshop, team, or department.",
  plus: "A local, one-user runtime on Linux (x64 or ARM64, with glibc) or an Apple silicon Mac.",
  rocket:
    "Broader customer-operated private-cloud planning for an institution or enterprise.",
  star: "A free shared CoCalc site in one Docker container.",
};

export interface PublicProductPath {
  detail: string;
  // Relative to the site's base path.
  href: string;
  title: string;
}

// The shown products among `ids`, as links to their pages.
export function getPublicProductPaths(
  ids: readonly PublicProductId[],
): PublicProductPath[] {
  return ids
    .filter((id) => isPublicProductShown(id))
    .map((id) => {
      const { name, slug } = getPublicProduct(id);
      return {
        detail: PUBLIC_PRODUCT_PATH_DETAILS[id],
        href: `products/${slug}`,
        title: name,
      };
    });
}

// The Where to run CoCalc page. Its first screen names CoCalc.ai, and CoCalc
// Star while the public pages show it; the list of paths has an entry for
// CoCalc.ai and for every shown product, Star included.

export const PUBLIC_WHERE_TO_RUN_TITLE = "Where to run CoCalc";

const COCALC_AI_TERMS =
  "CoCalc.ai is the hosted service run by SageMath, Inc., and the CoCalc.ai Terms of Service apply to it.";

const STAR_TERMS = "CoCalc Star is free of charge, and you operate it.";

export function getPublicWhereToRunHeadline(): string {
  return isPublicProductShown("star")
    ? "Run your agents on CoCalc.ai, or on a computer or server you control with CoCalc Star."
    : "Run your agents on CoCalc.ai.";
}

export function getPublicWhereToRunIntro(): string {
  return isPublicProductShown("star")
    ? `${COCALC_AI_TERMS} ${STAR_TERMS}`
    : COCALC_AI_TERMS;
}

// For search results and link previews.
export function getPublicWhereToRunDescription(): string {
  return isPublicProductShown("star")
    ? `${getPublicWhereToRunHeadline()} ${STAR_TERMS}`
    : `${getPublicWhereToRunHeadline()} ${COCALC_AI_TERMS}`;
}

const COCALC_AI_PATH: PublicProductPath = {
  detail: "Managed hosted projects for individuals and teams.",
  href: COCALC_AI_START_LINK.href,
  title: "CoCalc.ai",
};

export function getPublicWhereToRunActions(): PublicProductLink[] {
  return [
    { ...COCALC_AI_START_LINK, primary: true },
    ...(isPublicProductShown("star")
      ? [
          {
            href: "products/cocalc-star#install-cocalc-star",
            label: "Install CoCalc Star",
          },
        ]
      : []),
  ];
}

export const PUBLIC_WHERE_TO_RUN_PATHS_TITLE = "Where CoCalc runs";

// CoCalc.ai, then the products the public pages show.
export function getPublicWhereToRunPaths(): PublicProductPath[] {
  return [
    COCALC_AI_PATH,
    ...getPublicProductPaths(["plus", "star", "launchpad", "rocket"]),
  ];
}

export interface PublicWhereToRunRow {
  cocalcAi: string;
  label: string;
  star: string;
}

export interface PublicWhereToRunComparison {
  // Read by screen readers; the table's title is a heading on the page. The
  // React page adds a sentence about its narrow-screen layout.
  caption: string;
  rows: readonly PublicWhereToRunRow[];
  title: string;
}

// CoCalc.ai and CoCalc Star, side by side. Each row is confirmed for both; the
// agent features that CoCalc.ai has and that are not yet confirmed for Star
// are left out, rather than shown as blank cells, and the Agents page
// describes them.
export const PUBLIC_WHERE_TO_RUN_COMPARISON: PublicWhereToRunComparison = {
  caption: "Each row compares CoCalc.ai and CoCalc Star on one question.",
  rows: [
    {
      cocalcAi: "SageMath, Inc., as a hosted service",
      label: "Who runs it",
      star: "You, on a computer or server you control",
    },
    {
      cocalcAi: "Membership plans",
      label: "Price",
      star: "Free of charge",
    },
    {
      cocalcAi:
        "Built in; it can use your membership's included AI allowance or your own OpenAI API key",
      label: "Codex",
      star: "On by default; each person connects their own OpenAI API key, or an administrator sets a site key",
    },
    {
      cocalcAi: "With a paid membership",
      label: "Internet access in projects",
      star: "Every project",
    },
    {
      cocalcAi: "Restore from snapshots and backups",
      label: "Recovery",
      star: "You back up the Docker volume",
    },
  ],
  title: "Compare CoCalc.ai and CoCalc Star",
};

// The comparison, while the public pages show CoCalc Star.
export function getPublicWhereToRunComparison():
  | PublicWhereToRunComparison
  | undefined {
  return isPublicProductShown("star")
    ? PUBLIC_WHERE_TO_RUN_COMPARISON
    : undefined;
}

export const PUBLIC_WHERE_TO_RUN_AGENTS_LINK: PublicProductLink = {
  href: "features/ai",
  label: "See how agents work",
};

// The links under the comparison: how agents work, and how to set up the
// Codex access its Codex row names.
export const PUBLIC_WHERE_TO_RUN_COMPARISON_LINKS: readonly PublicProductLink[] =
  [PUBLIC_WHERE_TO_RUN_AGENTS_LINK, PUBLIC_CONNECT_AI_ACCESS_LINK];

export interface PublicWhereToRunWorkflowCard {
  body: string;
  // Relative to the site's base path.
  href: string;
  label: string;
  title: string;
}

// The page's next step, after the comparison: how people, agents and compute
// use a project, wherever CoCalc runs. Both renderers leave out the compute
// card where the Research Compute page is not shown.
export const PUBLIC_WHERE_TO_RUN_WORKFLOW: {
  body: string;
  cards: readonly PublicWhereToRunWorkflowCard[];
  title: string;
} = {
  body: "Where CoCalc runs decides who operates it. The next decision is how people, agents, and compute should use the project there.",
  cards: [
    {
      body: "See how people and agents use the same project files, notebooks, terminals, services, and review context.",
      href: "features/ai",
      label: "Explore AI agent workflows",
      title: "Agents and collaboration",
    },
    {
      // As the Research Compute page offers them.
      body: "Compare moving the whole project to a dedicated machine with connecting a notebook to a machine you already have, before choosing capacity.",
      href: "features/research-compute",
      label: "Plan research compute",
      title: "Compute capacity",
    },
    {
      body: "Decide whether the work needs a persistent, shared project or an API-managed execution environment.",
      href: "features/compare",
      label: "Compare with agent sandboxes",
      title: "Execution model",
    },
  ],
  title: "Plan the workflow once you know where CoCalc runs.",
};

export const PUBLIC_WHERE_TO_RUN_CONTACT: {
  body: string;
  links: readonly PublicProductLink[];
  title: string;
} = {
  body: "For a larger private deployment, or for support, talk with us.",
  links: [
    {
      href: publicProductContactPath({
        body: "I want to talk with CoCalc about where to run CoCalc. Helpful context: where you want CoCalc to run, who will operate it, expected users or projects, and support expectations.",
        context: "products-where-to-run",
        subject: "Where to run CoCalc",
        title: "Talk with CoCalc about where to run CoCalc",
      }),
      label: "Talk with us",
      primary: true,
    },
    PRICING_LINK,
  ],
  title: "Questions about where to run CoCalc?",
};

// Lines on other public pages that describe the ways to run CoCalc. Each names
// only what the shown products offer; with every product shown they read as
// they always have.

// Kinds of deployment the shown products offer, after "hosted".
function selfRunKinds({
  privateKind,
}: {
  privateKind: "private" | "organization-operated";
}): string[] {
  const local = isPublicProductShown("plus") || isPublicProductShown("star");
  const singleVm = isPublicProductShown("star");
  const privateDeployment =
    isPublicProductShown("launchpad") || isPublicProductShown("rocket");
  return [
    ...(local ? ["local"] : []),
    ...(singleVm ? ["single-VM"] : []),
    ...(privateDeployment ? [privateKind] : []),
  ];
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Home, the "Operating model choice" card.
export function getPublicHomeDeploymentChoice(): string {
  return `Choose ${joinPublicList(
    ["hosted", ...selfRunKinds({ privateKind: "organization-operated" })],
    "or",
  )} deployment.`;
}

// Home, the "Operating model choice" dialog: what Where to run CoCalc
// compares, while it shows its comparison.
export function getPublicHomeDeploymentComparison(): string {
  return getPublicWhereToRunComparison() != null
    ? "Compare who runs it, the price, Codex, internet access, and recovery."
    : "See who runs CoCalc.ai and which terms apply to it.";
}

// Home, the "Operating model choice" dialog.
export function getPublicHomeDeploymentRange(): string {
  const kinds = [
    ...(isPublicProductShown("plus") || isPublicProductShown("star")
      ? ["local"]
      : []),
    ...(isPublicProductShown("star") ? ["single-VM"] : []),
    ...(isPublicProductShown("launchpad") ? ["private"] : []),
    ...(isPublicProductShown("rocket") ? ["enterprise"] : []),
  ];
  const range =
    kinds.length > 0
      ? ` through ${joinPublicList(kinds, "and")} deployments`
      : "";
  return `CoCalc product paths are choices about where CoCalc runs and who operates it, from hosted CoCalc.ai${range}.`;
}

// Compare, the "Who operates it?" row.
export function getPublicCompareDeploymentNeed(): string {
  return `Teams need ${joinPublicList(
    ["hosted", ...selfRunKinds({ privateKind: "private" })],
    "and",
  )} deployment choices.`;
}

// Compare, the "Choosing how CoCalc runs" link.
export function getPublicCompareDeploymentSummary(): string {
  return `${capitalize(
    joinPublicList(
      ["hosted", ...selfRunKinds({ privateKind: "private" })],
      "and",
    ),
  )} deployment.`;
}

// Compare, the operating-boundary bullet of "Choose CoCalc when".
export function getPublicCompareDeploymentBullet(): string {
  const installation =
    isPublicProductShown("plus") || isPublicProductShown("star")
      ? [
          isPublicProductShown("star")
            ? "a local or single-VM installation"
            : "a local installation",
        ]
      : [];
  const privateDeployment =
    isPublicProductShown("launchpad") || isPublicProductShown("rocket")
      ? ["a customer-operated private deployment path"]
      : [];
  const options = ["a hosted service", ...installation, ...privateDeployment];
  if (options.length === 2) {
    return `You need ${options[0]}, or ${options[1]}`;
  }
  return `You need ${joinPublicList(options, "or")}`;
}

// The AI page's "Choose who runs CoCalc." cards.
export function getPublicAiOperatingModels(): {
  body: string;
  title: string;
}[] {
  const ownMachine = shownPublicProductNames(["plus", "star"], {
    short: true,
  });
  const ownMachineBody = [
    ...(isPublicProductShown("plus") ? ["use Plus on your own computer"] : []),
    ...(isPublicProductShown("star")
      ? ["run a shared Star site in one Docker container"]
      : []),
  ];
  const privatePaths = shownPublicProductNames(["launchpad", "rocket"], {
    short: true,
  });
  return [
    {
      body: "Managed hosted projects for individuals and teams.",
      title: "Hosted CoCalc.ai",
    },
    ...(ownMachine.length > 0
      ? [
          {
            body: `${capitalize(ownMachineBody.join(", or "))}.`,
            title: `CoCalc ${joinPublicList(ownMachine, "or")}`,
          },
        ]
      : []),
    ...(privatePaths.length > 0
      ? [
          {
            body:
              privatePaths.length > 1
                ? "Customer-operated private deployment paths for teams and institutions."
                : "A customer-operated private deployment path for teams and institutions.",
            title: joinPublicList(privatePaths, "or"),
          },
        ]
      : []),
  ];
}

// The pricing page's first paragraph on a CoCalc Plus install, which offers
// the other ways to run CoCalc that the public pages show.
export function getPublicPlusPricingIntro(): string {
  const needs = [
    "hosted collaboration",
    ...(isPublicProductShown("star") ? ["a shared VM"] : []),
    ...(isPublicProductShown("launchpad") || isPublicProductShown("rocket")
      ? ["a customer-operated private deployment"]
      : []),
  ];
  return `CoCalc Plus is the local, one-user runtime. Use the product paths below when you need ${joinPublicList(
    needs,
    "or",
  )}.`;
}

// The pricing page's customer-operated option.
export function getPublicCustomerOperatedSummary(): string {
  const plus = isPublicProductShown("plus");
  const star = isPublicProductShown("star");
  const privatePaths = shownPublicProductNames(["launchpad", "rocket"], {
    short: true,
  });
  // With no private deployment path shown, say where each shown product runs
  // and who operates it. Only Star's price is stated.
  if (privatePaths.length === 0) {
    if (plus && star) {
      return "Run CoCalc on your own computer with CoCalc Plus, or on a computer or server you control with CoCalc Star. You operate either one, and CoCalc Star is free of charge.";
    }
    if (plus) {
      return "Run CoCalc on your own computer with CoCalc Plus, which you operate.";
    }
    return star
      ? "Run CoCalc on a computer or server you control. CoCalc Star is free of charge, and you operate it."
      : "For a larger private deployment, or for support, talk with us.";
  }
  const paths = [
    ...(plus ? ["local CoCalc Plus"] : []),
    ...(star ? ["one-VM CoCalc Star"] : []),
    ...(privatePaths.length > 0
      ? [
          `the ${joinPublicList(privatePaths, "and")} private-deployment ${
            privatePaths.length > 1 ? "paths" : "path"
          }`,
        ]
      : []),
  ];
  return `Compare ${joinPublicList(paths, "and")}. You or your organization operate the infrastructure, recovery, and ongoing service.`;
}
