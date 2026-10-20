import {
  DOLLAR_AMOUNT,
  INTERNAL_IMPLEMENTATION_TERMS,
  OVERPROMISE_TERMS,
  STALE_AGENT_PHRASES,
  UNSUPPORTED_CAPABILITY_TERMS,
} from "./public-copy-guards";
import { getPublicGuideGroups } from "./public-guides";
import { getPublicPricingCustomerOperated } from "./public-pricing";
import {
  PUBLIC_PRODUCT_AVAILABILITY,
  type PublicProductId,
} from "./public-product-availability";
import {
  getPublicAiOperatingModels,
  getPublicCompareDeploymentBullet,
  getPublicCompareDeploymentNeed,
  getPublicCompareDeploymentSummary,
  getPublicHomeDeploymentChoice,
  getPublicHomeDeploymentComparison,
  getPublicHomeDeploymentRange,
  getPublicPlusPricingIntro,
  getPublicProductPageCopy,
  getPublicWhereToRunActions,
  getPublicWhereToRunComparison,
  getPublicWhereToRunDescription,
  getPublicWhereToRunHeadline,
  getPublicWhereToRunIntro,
  getPublicWhereToRunPaths,
  joinPublicList,
  PUBLIC_LAUNCHPAD_INSTALL_COMMAND,
  PUBLIC_PLUS_INSTALL_COMMAND,
  PUBLIC_PLUS_INSTALL_SCRIPT_URL,
  PUBLIC_PLUS_UNINSTALL_COMMAND,
  PUBLIC_PRODUCT_PATH_DETAILS,
  PUBLIC_STAR_INSTALL_COMMAND,
  PUBLIC_STAR_REMOVE_COMMANDS,
  PUBLIC_WHERE_TO_RUN_COMPARISON,
  PUBLIC_WHERE_TO_RUN_COMPARISON_LINKS,
  PUBLIC_WHERE_TO_RUN_WORKFLOW,
  publicProductTextParts,
  type PublicProductBlock,
  type PublicProductLink,
  type PublicProductPageCopy,
} from "./public-products-content";

const PRODUCT_IDS: PublicProductId[] = ["plus", "star", "launchpad", "rocket"];

// Launchpad and Rocket are hidden until their releases are current.
const HIDDEN_PRODUCT_NAMES = /\b(Launchpad|Rocket)\b/;
// Links to a hidden product's page; a page's own install anchor is not one.
const HIDDEN_PRODUCT_PAGES =
  /products\/cocalc-(launchpad|rocket)|cocalc-(launchpad|rocket)\/$/;

afterEach(() => jest.restoreAllMocks());

function showAllProducts() {
  for (const id of ["plus", "launchpad", "rocket"] as const) {
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, id, true);
  }
}

// What a reader sees of a card's block.
function blockText(block: PublicProductBlock): string {
  if (typeof block === "string" || "text" in block) {
    return publicProductTextParts(block)
      .map((part) =>
        "code" in part
          ? part.code
          : "link" in part
            ? part.link.label
            : part.text,
      )
      .join("");
  }
  return "note" in block ? block.note : block.code;
}

function blockLinks(block: PublicProductBlock): PublicProductLink[] {
  return typeof block === "string" || "text" in block
    ? publicProductTextParts(block).flatMap((part) =>
        "link" in part ? [part.link] : [],
      )
    : [];
}

function copyText(copy: PublicProductPageCopy): string[] {
  return [
    copy.lead.title,
    ...copy.lead.paragraphs,
    ...copy.lead.actions.map(({ label }) => label),
    ...copy.points.flatMap(({ body, title }) => [title, body]),
    ...copy.sections.flatMap(({ blocks, links = [], title }) => [
      title,
      ...blocks.map(blockText),
      ...links.map(({ label }) => label),
    ]),
    copy.notesTitle,
    ...copy.notes,
    ...copy.links.map(({ label }) => label),
  ];
}

function copyHrefs(copy: PublicProductPageCopy): string[] {
  return [
    ...copy.lead.actions,
    ...copy.sections.flatMap(({ blocks, links = [] }) => [
      ...blocks.flatMap(blockLinks),
      ...links,
    ]),
    ...copy.links,
  ].map(({ href }) => href);
}

// Lines on other public pages that describe the ways to run CoCalc.
function deploymentLines(): string[] {
  return [
    getPublicHomeDeploymentChoice(),
    getPublicHomeDeploymentRange(),
    getPublicCompareDeploymentNeed(),
    getPublicCompareDeploymentSummary(),
    getPublicCompareDeploymentBullet(),
    ...getPublicAiOperatingModels().flatMap(({ body, title }) => [title, body]),
    getPublicPricingCustomerOperated().body,
  ];
}

// The guides list, which also links field guides.
function guideLines(): string[] {
  return getPublicGuideGroups().flatMap(({ guides, intro, title }) => [
    title,
    intro,
    ...guides.flatMap((guide) => [guide.title, guide.body, guide.href]),
  ]);
}

describe("joinPublicList", () => {
  it("joins one, two, or more items", () => {
    expect(joinPublicList([], "or")).toBe("");
    expect(joinPublicList(["A"], "or")).toBe("A");
    expect(joinPublicList(["A", "B"], "and")).toBe("A and B");
    expect(joinPublicList(["A", "B", "C"], "or")).toBe("A, B, or C");
  });
});

describe("product copy while Launchpad and Rocket are hidden", () => {
  it("links to no hidden product from the Star page", () => {
    const star = getPublicProductPageCopy("star");
    for (const href of copyHrefs(star)) {
      expect(href).not.toMatch(HIDDEN_PRODUCT_PAGES);
    }
    for (const text of copyText(star)) {
      expect(text).not.toMatch(HIDDEN_PRODUCT_NAMES);
    }
  });

  it("names CoCalc Plus and Star, and no hidden product, on other public pages", () => {
    for (const line of [...deploymentLines(), ...guideLines()]) {
      expect(line).not.toMatch(HIDDEN_PRODUCT_NAMES);
      expect(line).not.toMatch(HIDDEN_PRODUCT_PAGES);
    }
    // Nor describes one: Plus and Star are the ways to run CoCalc yourself.
    // The pricing intro on a Plus install names Plus whatever its switch says,
    // so it is checked here and not with the other lines.
    for (const line of [...deploymentLines(), getPublicPlusPricingIntro()]) {
      expect(line).not.toMatch(
        /private deployment|private-deployment|enterprise|organization-operated/,
      );
    }
    expect(getPublicPlusPricingIntro()).toBe(
      "CoCalc Plus is the local, one-user runtime. Use the product paths below when you need hosted collaboration or a shared VM.",
    );
    expect(getPublicHomeDeploymentChoice()).toBe(
      "Choose hosted, local, or single-VM deployment.",
    );
    expect(getPublicHomeDeploymentRange()).toBe(
      "CoCalc product paths are choices about where CoCalc runs and who operates it, from hosted CoCalc.ai through local and single-VM deployments.",
    );
    expect(getPublicCompareDeploymentNeed()).toBe(
      "Teams need hosted, local, and single-VM deployment choices.",
    );
    expect(getPublicCompareDeploymentSummary()).toBe(
      "Hosted, local, and single-VM deployment.",
    );
    expect(getPublicAiOperatingModels()).toEqual([
      {
        body: "Managed hosted projects for individuals and teams.",
        title: "Hosted CoCalc.ai",
      },
      {
        body: "Use Plus on your own computer, or run a shared Star site in one Docker container.",
        title: "CoCalc Plus or Star",
      },
    ]);
    expect(getPublicPricingCustomerOperated()).toEqual({
      body: "Run CoCalc on your own computer with CoCalc Plus, or on a computer or server you control with CoCalc Star. You operate either one, and CoCalc Star is free of charge.",
      title: "Customer-operated deployments",
    });
    const operatingPaths = getPublicGuideGroups().find(
      ({ title }) => title === "Operating paths",
    )!;
    expect(operatingPaths.intro).toBe(
      "Self-hosting, local evaluation, durable collaborative projects, and architecture.",
    );
    expect(operatingPaths.guides.map(({ title }) => title)).toContain(
      "CoCalc Plus",
    );
  });

  it("keeps the hidden products' pages, with their return copy", () => {
    expect(getPublicProductPageCopy("launchpad").lead.paragraphs).toEqual([
      "CoCalc Launchpad runs a private CoCalc site for a small group, on infrastructure your team operates. Running Launchpad for an organization requires a license agreement with SageMath, Inc.; talk with us before you deploy.",
    ]);
    expect(getPublicProductPageCopy("rocket").lead.paragraphs).toEqual([
      "CoCalc Rocket is for larger private-cloud deployments. Licensing, support and deployment terms are agreed with SageMath, Inc. before rollout.",
    ]);
    // Every product page's cross-links name only shown products.
    for (const id of PRODUCT_IDS) {
      const copy = getPublicProductPageCopy(id);
      for (const href of copyHrefs(copy)) {
        expect(href).not.toMatch(HIDDEN_PRODUCT_PAGES);
      }
    }
    expect(getPublicProductPageCopy("plus").notes).not.toContain(
      "Use Star, Launchpad, or Rocket when the group needs a shared deployment.",
    );
    expect(getPublicProductPageCopy("plus").notes).toContain(
      "Use Star when the group needs a shared deployment.",
    );
  });
});

// The lines on other pages follow Plus's switch: hidden, they name Star alone.
describe("product copy once Plus is hidden again", () => {
  beforeEach(() => {
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "plus", false);
  });

  it("names no hidden product on other public pages", () => {
    for (const line of [...deploymentLines(), ...guideLines()]) {
      expect(line).not.toMatch(/\b(Plus|Launchpad|Rocket)\b/);
      expect(line).not.toMatch(/products\/cocalc-plus/);
    }
    expect(getPublicAiOperatingModels()).toEqual([
      {
        body: "Managed hosted projects for individuals and teams.",
        title: "Hosted CoCalc.ai",
      },
      {
        body: "Run a shared Star site in one Docker container.",
        title: "CoCalc Star",
      },
    ]);
    expect(getPublicPricingCustomerOperated()).toEqual({
      body: "Run CoCalc on a computer or server you control. CoCalc Star is free of charge, and you operate it.",
      title: "Customer-operated deployments",
    });
    expect(
      getPublicGuideGroups().find(({ title }) => title === "Operating paths")!
        .intro,
    ).toBe("Self-hosting, durable collaborative projects, and architecture.");
  });
});

describe("the Star page", () => {
  const star = getPublicProductPageCopy("star");

  it("states the price, publisher and operating terms", () => {
    expect(star.lead.paragraphs).toEqual([
      "CoCalc Star is free of charge. SageMath, Inc. publishes it on Docker Hub as sagemathinc/star. You run Star on your own computer or server, and you are responsible for operating it, including upgrades and backups. For a larger private deployment, or for support, talk with us.",
    ]);
    expect(star.lead.actions.map(({ label }) => label)).toEqual([
      "Install CoCalc Star",
      "Talk with us",
    ]);
    expect(star.lead.actions[1].href).toMatch(/^support\/new\?/);
  });

  // The page carries only price and operating facts.
  it("says who can sign up, not whom Star is for", () => {
    expect(star.lead.title).toBe("Your agents, on one machine you control.");
    expect(star.points[0]).toEqual({
      body: "Star is for people you invite: signing up requires a registration link.",
      title: "Who can sign up",
    });
    expect(copyText(star).join(" ")).not.toMatch(
      /\b(labs?|courses?|teams?|group's|organi[sz]ations?|institutions?)\b/i,
    );
  });

  it("names only Codex among the agents, and links its setup guide", () => {
    const agents = star.sections.find(({ key }) => key === "agents")!;
    expect(agents.title).toBe("Agents on Star");
    expect(agents.blocks[0]).toBe(
      "Codex is on by default in CoCalc Star. Each person connects their own OpenAI API key, or an administrator sets a site key.",
    );
    expect(agents.links).toEqual([
      { href: "docs/ai/connect-credentials", label: "Connect AI access" },
    ]);
    expect(copyText(star).join(" ")).not.toMatch(/Claude|sensor|Agent Network/);
  });

  it("says that projects stop during an upgrade, that invitees need a DNS name, and where quotas are missing", () => {
    const text = copyText(star).join(" ");
    expect(text).toContain(
      "Running projects stop during the upgrade and can be started again right away.",
    );
    expect(text).not.toMatch(/projects (are )?restarted/i);
    expect(text).toContain(
      "run it on a Linux server with a DNS name so the people you invite can reach it",
    );
    expect(text).toContain(
      "With Docker Desktop on Windows, and on Linux kernels older than 6.7, projects share the volume's disk space without per-project quotas.",
    );
  });
});

// The facts of the CoCalc Plus installer and of how Codex runs on Plus.
describe("the CoCalc Plus page", () => {
  const plus = () => getPublicProductPageCopy("plus");
  const section = (key: string) =>
    plus().sections.find((candidate) => candidate.key === key)!;
  const sectionText = (key: string) =>
    section(key).blocks.map(blockText).join(" ");

  it("says that Codex works through the Codex CLI you install", () => {
    expect(plus().lead.paragraphs).toEqual([
      "CoCalc Plus runs CoCalc on your own computer, for your own projects. Codex works through the Codex CLI you install, with your own OpenAI API key.",
    ]);
    expect(section("agents").blocks).toEqual([
      "Codex works in chat, with your local files and installed tools.",
      "You choose how much Codex may change: Read only, Workspace write (the default) or Full access.",
      "Other command-line agents can run in a terminal. Requests from Codex and from these agents leave your computer.",
    ]);
    expect(copyText(plus()).join(" ")).not.toMatch(/Codex is built in/);
  });

  it("names the installer's platforms: Linux on x64 or ARM64 with glibc, and Apple silicon Macs", () => {
    for (const line of [
      plus().points.find(({ title }) => title === "How it runs")!.body,
      blockText(section("install").blocks[0]),
      PUBLIC_PRODUCT_PATH_DETAILS.plus,
    ]) {
      expect(line).toMatch(/Linux (machine )?\(x64 or ARM64, with glibc\)/);
      expect(line).toContain("an Apple silicon Mac");
    }
    expect(
      [...copyText(plus()), PUBLIC_PRODUCT_PATH_DETAILS.plus].join(" "),
    ).not.toMatch(/macOS|Windows|Intel/);
  });

  it("puts the install, update and uninstall steps on the page", () => {
    expect(PUBLIC_PLUS_INSTALL_COMMAND).toBe(
      "curl -fsSL https://software.cocalc.ai/software/plus/install.sh | sh",
    );
    expect(section("install").blocks).toContainEqual({
      code: PUBLIC_PLUS_INSTALL_COMMAND,
      label: "Install command",
    });
    expect(section("install").links).toEqual([
      { href: PUBLIC_PLUS_INSTALL_SCRIPT_URL, label: "Open install script" },
    ]);
    expect(sectionText("install")).toContain(
      "By default it installs CoCalc Plus for your user in ~/.local/share/cocalc/plus, with the cocalc-plus launcher in ~/.local/bin, which it adds to your PATH if needed. Then start it with cocalc-plus.",
    );
    expect(sectionText("install")).toContain(
      "On Linux, CoCalc Plus needs libatomic.so.1",
    );
    expect(sectionText("update")).toContain(
      "CoCalc Plus keeps itself up to date: while it runs, it installs new releases in the background, and each takes effect the next time CoCalc Plus starts.",
    );
    expect(section("update").blocks).toContainEqual({
      code: "cocalc-plus update",
      label: "Update command",
    });
    expect(PUBLIC_PLUS_UNINSTALL_COMMAND).toBe(
      "rm -rf ~/.local/share/cocalc/plus ~/.local/bin/cocalc-plus",
    );
    expect(section("uninstall").blocks).toContainEqual({
      code: PUBLIC_PLUS_UNINSTALL_COMMAND,
      label: "Uninstall command",
    });
    // The installer honors XDG_DATA_HOME and XDG_BIN_HOME.
    expect(sectionText("uninstall")).toContain(
      "These are the default locations. If XDG_DATA_HOME was set when you installed CoCalc Plus, its install folder is $XDG_DATA_HOME/cocalc/plus; if XDG_BIN_HOME was set, its launcher is $XDG_BIN_HOME/cocalc-plus.",
    );
    expect(sectionText("uninstall")).toContain(
      "If the installer added the launcher's folder to your PATH, also remove the line it appended to your shell's startup file: ~/.zshrc, ~/.bashrc, ~/.config/fish/config.fish or ~/.profile.",
    );
    expect(sectionText("uninstall")).toContain(
      "Uninstalling keeps your CoCalc Plus data, in ~/.local/share/cocalc-plus/data on Linux or ~/Library/Application Support/cocalc-plus/data on a Mac.",
    );
    // No other page holds these steps, and none of the older installers'
    // pages is linked.
    expect(plus().links).toEqual([]);
    for (const href of copyHrefs(plus())) {
      expect(href).not.toMatch(
        /software\.cocalc\.ai\/software\/cocalc(-plus)?\//,
      );
    }
  });

  it("lists what is on CoCalc.ai instead, and states no price or other terms", () => {
    expect(plus().notes).toContain(
      "Named agents and sharing, Claude, sensors, and snapshots and backups are on CoCalc.ai.",
    );
    const text = copyText(plus()).join(" ");
    expect(text).not.toMatch(/browser/i);
    expect(text).not.toMatch(/\bComputers\b/);
    expect(text).not.toMatch(/\bfree\b/i);
    expect(text).not.toMatch(/Software Terms/);
  });

  it("names Plus on the pricing page without a price", () => {
    expect(getPublicPricingCustomerOperated().body).toBe(
      "Run CoCalc on your own computer with CoCalc Plus, or on a computer or server you control with CoCalc Star. You operate either one, and CoCalc Star is free of charge.",
    );
  });
});

describe("product page steps and commands", () => {
  // The crawler fallback renders these too, so a reader without JavaScript
  // finds the command under each install heading.
  it.each([
    ["star", PUBLIC_STAR_INSTALL_COMMAND],
    ["plus", PUBLIC_PLUS_INSTALL_COMMAND],
    ["launchpad", PUBLIC_LAUNCHPAD_INSTALL_COMMAND],
  ] as const)(
    "puts the %s install command in its install section",
    (id, code) => {
      const install = getPublicProductPageCopy(id).sections.find(
        ({ key }) => key === "install",
      )!;
      expect(install.blocks).toContainEqual({ code, label: "Install command" });
    },
  );

  it("removes Star under its removal heading, with the AppArmor note", () => {
    const star = getPublicProductPageCopy("star");
    const remove = star.sections.find(({ key }) => key === "remove")!;
    expect(remove.title).toBe("Remove it completely");
    expect(remove.blocks).toContainEqual({
      code: PUBLIC_STAR_REMOVE_COMMANDS,
      label: "Remove commands",
    });
    expect(remove.blocks.map(blockText).join(" ")).toContain(
      "On Linux hosts with AppArmor",
    );
    // The page's boundary notes have their own heading.
    expect(star.notesTitle).not.toBe(remove.title);
    expect(star.notes).toEqual([
      "Star is one machine: it is not a high-availability or scale-out deployment.",
    ]);
  });

  it("reads a paragraph's code and links in order", () => {
    expect(
      publicProductTextParts({
        text: [
          "Open ",
          { href: "https://example.com", label: "the site" },
          " and run `star status` there.",
        ],
      }),
    ).toEqual([
      { text: "Open " },
      { link: { href: "https://example.com", label: "the site" } },
      { text: " and run " },
      { code: "star status" },
      { text: " there." },
    ]);
  });
});

describe("the Where to run CoCalc first screen", () => {
  it("names CoCalc Star while the public pages show it", () => {
    expect(getPublicWhereToRunHeadline()).toBe(
      "Run your agents on CoCalc.ai, or on a computer or server you control with CoCalc Star.",
    );
    expect(getPublicWhereToRunIntro()).toBe(
      "CoCalc.ai is the hosted service run by SageMath, Inc., and the CoCalc.ai Terms of Service apply to it. CoCalc Star is free of charge, and you operate it.",
    );
    expect(getPublicWhereToRunDescription()).toBe(
      "Run your agents on CoCalc.ai, or on a computer or server you control with CoCalc Star. CoCalc Star is free of charge, and you operate it.",
    );
    expect(getPublicHomeDeploymentComparison()).toBe(
      "Compare who runs it, the price, Codex, internet access, and recovery.",
    );
  });

  it("names only CoCalc.ai once Star is hidden", () => {
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "star", false);

    expect(getPublicWhereToRunHeadline()).toBe("Run your agents on CoCalc.ai.");
    expect(getPublicWhereToRunIntro()).toBe(
      "CoCalc.ai is the hosted service run by SageMath, Inc., and the CoCalc.ai Terms of Service apply to it.",
    );
    expect(getPublicWhereToRunComparison()).toBeUndefined();
    expect(getPublicHomeDeploymentComparison()).toBe(
      "See who runs CoCalc.ai and which terms apply to it.",
    );
    expect(getPublicPlusPricingIntro()).toBe(
      "CoCalc Plus is the local, one-user runtime. Use the product paths below when you need hosted collaboration.",
    );
    for (const text of [
      getPublicWhereToRunHeadline(),
      getPublicWhereToRunIntro(),
      getPublicWhereToRunDescription(),
      ...getPublicWhereToRunActions().map(({ label }) => label),
      ...getPublicWhereToRunPaths().flatMap(({ detail, title }) => [
        title,
        detail,
      ]),
    ]) {
      expect(text).not.toMatch(/\bStar\b/);
    }
    // Search results cut descriptions at about 160 characters.
    expect(getPublicWhereToRunDescription().length).toBeLessThanOrEqual(160);
  });
});

describe("the Where to run CoCalc workflow section", () => {
  it("calls the place agents work a project, and offers no managed VMs", () => {
    const text = JSON.stringify(PUBLIC_WHERE_TO_RUN_WORKFLOW);
    expect(text).not.toMatch(/workspace|operating model/i);
    // As on the Research Compute page, until managed VMs are generally
    // available.
    expect(text).not.toMatch(/\bVMs?\b|virtual machines?/i);
  });
});

describe("the Where to run CoCalc comparison", () => {
  it("says what pays for Codex on each, and links its setup guide", () => {
    expect(
      PUBLIC_WHERE_TO_RUN_COMPARISON.rows.find(
        ({ label }) => label === "Codex",
      ),
    ).toEqual({
      cocalcAi:
        "Built in; it can use your membership's included AI allowance or your own OpenAI API key",
      label: "Codex",
      star: "On by default; each person connects their own OpenAI API key, or an administrator sets a site key",
    });
    expect(PUBLIC_WHERE_TO_RUN_COMPARISON_LINKS).toEqual([
      { href: "features/ai", label: "See how agents work" },
      { href: "docs/ai/connect-credentials", label: "Connect AI access" },
    ]);
    for (const { cocalcAi, star } of PUBLIC_WHERE_TO_RUN_COMPARISON.rows) {
      expect(`${cocalcAi} ${star}`).not.toMatch(/ChatGPT|OpenAI account/);
    }
  });
});

describe("product copy with every product shown", () => {
  beforeEach(showAllProducts);

  it("reads on other public pages as it always has", () => {
    expect(getPublicHomeDeploymentChoice()).toBe(
      "Choose hosted, local, single-VM, or organization-operated deployment.",
    );
    expect(getPublicHomeDeploymentRange()).toBe(
      "CoCalc product paths are choices about where CoCalc runs and who operates it, from hosted CoCalc.ai through local, single-VM, private, and enterprise deployments.",
    );
    expect(getPublicCompareDeploymentNeed()).toBe(
      "Teams need hosted, local, single-VM, and private deployment choices.",
    );
    expect(getPublicCompareDeploymentSummary()).toBe(
      "Hosted, local, single-VM, and private deployment.",
    );
    expect(getPublicCompareDeploymentBullet()).toBe(
      "You need a hosted service, a local or single-VM installation, or a customer-operated private deployment path",
    );
    expect(getPublicAiOperatingModels()).toEqual([
      {
        body: "Managed hosted projects for individuals and teams.",
        title: "Hosted CoCalc.ai",
      },
      {
        body: "Use Plus on your own computer, or run a shared Star site in one Docker container.",
        title: "CoCalc Plus or Star",
      },
      {
        body: "Customer-operated private deployment paths for teams and institutions.",
        title: "Launchpad or Rocket",
      },
    ]);
    expect(getPublicPricingCustomerOperated().body).toBe(
      "Compare local CoCalc Plus, one-VM CoCalc Star, and the Launchpad and Rocket private-deployment paths. You or your organization operate the infrastructure, recovery, and ongoing service.",
    );
    expect(getPublicPlusPricingIntro()).toBe(
      "CoCalc Plus is the local, one-user runtime. Use the product paths below when you need hosted collaboration, a shared VM, or a customer-operated private deployment.",
    );
    const operatingPaths = getPublicGuideGroups().find(
      ({ title }) => title === "Operating paths",
    )!;
    expect(operatingPaths.intro).toBe(
      "Self-hosting, local evaluation, durable collaborative projects, and architecture.",
    );
    expect(operatingPaths.guides.map(({ title }) => title)).toContain(
      "CoCalc Plus",
    );
  });

  it("cross-links the product pages", () => {
    expect(
      getPublicProductPageCopy("star").lead.actions.map(({ href }) => href),
    ).toEqual(
      expect.arrayContaining([
        "products/cocalc-launchpad",
        "products/cocalc-rocket",
      ]),
    );
    expect(getPublicProductPageCopy("star").notes).toContain(
      "Use Launchpad or Rocket when private deployment or institutional rollout is the real decision.",
    );
    expect(getPublicProductPageCopy("plus").notes).toContain(
      "Use Star, Launchpad, or Rocket when the group needs a shared deployment.",
    );
    expect(getPublicProductPageCopy("launchpad").notes).toContain(
      "Use Rocket when governance, support, and broader private-cloud planning are the main decision.",
    );
    expect(copyHrefs(getPublicProductPageCopy("rocket"))).toContain(
      "products/cocalc-launchpad",
    );
  });
});

describe("product copy guards", () => {
  // CoCalc is an agent platform; "workspace" is not its category word.
  it.each([
    ["hidden", () => undefined],
    ["shown", showAllProducts],
  ])(
    "does not call CoCalc a workspace on other public pages (%s)",
    (_state, setup) => {
      setup();
      for (const line of deploymentLines()) {
        expect(line).not.toMatch(/workspace/i);
      }
    },
  );

  it.each([
    ["hidden", () => undefined],
    ["shown", showAllProducts],
  ])(
    "keeps every product page within the public copy guards (%s)",
    (_state, setup) => {
      setup();
      for (const id of PRODUCT_IDS) {
        const copy = getPublicProductPageCopy(id);
        for (const text of copyText(copy)) {
          expect(text).not.toMatch(OVERPROMISE_TERMS);
          expect(text).not.toMatch(UNSUPPORTED_CAPABILITY_TERMS);
          expect(text).not.toMatch(STALE_AGENT_PHRASES);
          expect(text).not.toMatch(DOLLAR_AMOUNT);
          // The agent runtime is named Claude; Claude Code is the terminal
          // program.
          expect(text).not.toContain("Claude Code");
          // Codex access is an OpenAI API key, or an included allowance or
          // site key; the pages do not name a ChatGPT plan or an OpenAI
          // account.
          expect(text).not.toMatch(/ChatGPT|OpenAI account/);
        }
        expect(copy.lead.title).not.toMatch(INTERNAL_IMPLEMENTATION_TERMS);
        // No vendor name in a page's lead heading.
        expect(copy.lead.title).not.toMatch(/Codex|Claude|OpenAI|ChatGPT/);
      }
    },
  );
});
