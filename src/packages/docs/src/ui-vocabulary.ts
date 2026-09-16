/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Interface names that the documentation and the support conventions rely on.
//
// Each entry binds a label to the source text that defines or renders it, and
// to the documentation and support-convention files that quote it. The test in
// test/ui-vocabulary.test.cjs checks both directions, so a rename in the
// interface cannot silently leave the documentation or the support agents'
// vocabulary behind, and a name the interface does not use cannot creep back
// into the documentation. The test runs from the docs `verify` script, which
// CI runs on every pull request.
//
// Paths are relative to src/packages. Source text is compared after collapsing
// runs of whitespace, so reformatting does not break an anchor; escapes are not
// decoded. Anchors are the smallest fragment that identifies the label. An i18n
// message is anchored by its id, and its text must appear inside that message's
// own definition, so reordering or adding fields does not break it.

export interface UiVocabularyAnchor {
  file: string;
  text: string;
  role: "definition" | "renderer";
  /** When set, `text` must appear inside the definition carrying this id. */
  messageId?: string;
}

export interface UiVocabularyUse {
  file: string;
  /** Text that must appear in the file; defaults to the label. */
  text?: string;
}

export interface UiVocabularyEntry {
  id: string;
  /** Rendered text, or a pattern with {placeholders} for a composed label. */
  label: string;
  anchors: readonly UiVocabularyAnchor[];
  usedIn: readonly UiVocabularyUse[];
  /** Wordings the documentation must not use for this element. */
  aliases?: readonly string[];
}

export interface UiVocabularyFact {
  id: string;
  file: string;
  /** Text that must be present, or absent between `after` and `before`. */
  text: string;
  kind: "present" | "absent-between";
  after?: string;
  before?: string;
  /** Why the conventions depend on this fact, and what to update if it breaks. */
  reason: string;
}

export interface UiVocabularyAliasException {
  file: string;
  /** A fragment of the line that is allowed to contain an alias. */
  line: string;
  reason: string;
}

const CONVENTIONS = "conat/hub/api/admin-support.ts";
const COMMON = "frontend/i18n/common.ts";
const FILE_TAB = "frontend/project/page/file-tab.tsx";
const HOST_DRAWER = "frontend/hosts/components/host-drawer.tsx";
const EXAM_PANEL = "frontend/hosts/components/host-exam-panel.tsx";
const VMS = "frontend/project/compute-vms.tsx";
const JUPYTER_COMMANDS = "frontend/jupyter/commands.ts";
const JUPYTER_EDITOR = "frontend/frame-editors/jupyter-editor/editor.ts";
const STUDIO_CONTROLS = "frontend/jupyter/studio/studio-controls.tsx";
const STUDIO_TOGGLE = "frontend/jupyter/studio/frame-type-toggle.tsx";
const LOG = "frontend/project/history/log.tsx";
const AUTH_APP = "frontend/public/auth/app.tsx";
const CLI_AUTH = "frontend/public/auth/cli-auth-views.tsx";
const APP_PAGE = "frontend/app/page.tsx";
const ADMIN_PAGE = "frontend/admin/page.tsx";
const QUICK_NAV_DATA = "frontend/app/quick-navigation/use-data.ts";
const SECTIONS = "frontend/project/settings/sections.tsx";

const doc = (name: string): string => `docs/src/content/${name}.ts`;
const entries = (name: string): string => `docs/src/entries/${name}.ts`;
const def = (file: string, text: string): UiVocabularyAnchor => ({
  file,
  text,
  role: "definition",
});
const ren = (file: string, text: string): UiVocabularyAnchor => ({
  file,
  text,
  role: "renderer",
});
const msg = (
  file: string,
  messageId: string,
  text: string,
): UiVocabularyAnchor => ({ file, messageId, text, role: "definition" });
const conventions = (text: string): UiVocabularyUse => ({
  file: CONVENTIONS,
  text,
});
const bold = (name: string, label: string): UiVocabularyUse => ({
  file: doc(name),
  text: `**${label}**`,
});

export const UI_VOCABULARY: readonly UiVocabularyEntry[] = [
  // Project rail, flyouts and full pages
  {
    id: "rail.files",
    label: "Files",
    anchors: [
      msg(COMMON, "labels.explorer", 'defaultMessage: "Files"'),
      ren(FILE_TAB, "label: labels.explorer,"),
    ],
    usedIn: [
      conventions("left-rail tab for a project's files is Files"),
      ...[
        "files",
        "jupyter",
        "remote-jupyter",
        "research-remote",
        "research-specialist",
        "research-workflows",
        "teaching",
        "terminal",
      ].map((name) => bold(name, "Files")),
    ],
    aliases: ["file browser"],
  },
  {
    id: "files.tour",
    label: "Tour of the File Explorer",
    anchors: [
      def(
        "frontend/project/explorer/tour/tour.tsx",
        "Tour of the File Explorer",
      ),
      ren("frontend/project/explorer/explorer.tsx", "<ExplorerTour"),
    ],
    usedIn: [conventions("Tour of the File Explorer")],
  },
  {
    id: "rail.activity-bar-setting",
    label: "Activity Bar",
    anchors: [
      msg(
        "frontend/project/page/activity-bar-consts.ts",
        "project.page.activity-bar.title",
        'defaultMessage: "Activity Bar"',
      ),
      ren(
        "frontend/account/other-settings.tsx",
        "intl.formatMessage(ACTIVITY_BAR_TITLE)",
      ),
    ],
    usedIn: [conventions("account settings call the Activity Bar")],
  },
  {
    id: "rail.customize",
    label: "Customize left rail",
    anchors: [
      def(
        "frontend/project/page/activity-bar-tabs.tsx",
        'title="Customize left rail"',
      ),
    ],
    usedIn: [conventions("the left rail itself")],
  },
  {
    id: "rail.open-as-flyout",
    label: "Open as flyout",
    anchors: [def("frontend/project/page/page.tsx", 'title="Open as flyout"')],
    usedIn: [conventions("Open as flyout")],
  },
  {
    id: "rail.open-as-full-page",
    label: "Open as full page",
    anchors: [
      def(
        "frontend/project/page/flyouts/header.tsx",
        'title="Open as full page"',
      ),
    ],
    usedIn: [conventions("Open as full page")],
  },
  {
    id: "rail.agents",
    label: "Agents",
    anchors: [
      msg(
        FILE_TAB,
        "project.page.file-tab.agents.label",
        'defaultMessage: "Agents"',
      ),
    ],
    usedIn: [conventions("the Agents rail tab")],
  },
  {
    id: "assistant.codex",
    label: "Codex",
    // labels.assistant also says "Codex" but no component renders it, so it
    // cannot anchor anything.
    anchors: [
      ren("frontend/chat/agent-message-status.tsx", ">Codex activity<"),
      def("essential-frontend/src/ui.tsx", 'label: "Codex"'),
    ],
    usedIn: [conventions("the Codex assistant")],
  },
  {
    id: "rail.image",
    label: "Image",
    anchors: [
      msg(
        FILE_TAB,
        "project.page.file-tab.rootfs.label",
        'defaultMessage: "Image"',
      ),
    ],
    usedIn: [conventions("the Image rail tab")],
  },
  {
    id: "rail.docs",
    label: "Help for this project",
    anchors: [
      def(FILE_TAB, 'label: "Docs",'),
      def(FILE_TAB, 'flyoutTitle: "Docs",'),
      ren("frontend/project/page/flyouts/docs.tsx", "Help for this project"),
    ],
    usedIn: [
      conventions(
        "the Docs rail tab, whose page and flyout both show the title Help for this project",
      ),
    ],
  },
  {
    id: "rail.vms",
    label: "Virtual machines",
    anchors: [
      def(FILE_TAB, 'label: "VMs",'),
      def(FILE_TAB, 'flyoutTitle: "Virtual machines",'),
      ren(VMS, "Virtual machines </Title>"),
    ],
    usedIn: [
      conventions(
        "the VMs rail tab, whose page and flyout are titled Virtual machines",
      ),
    ],
  },
  {
    id: "rail.log.page-files",
    label: "Recent Files",
    anchors: [
      msg(
        LOG,
        "project.history.log.recent_files_title",
        'defaultMessage="Recent Files"',
      ),
    ],
    usedIn: [conventions("titled Recent Files or Project Activity Log")],
  },
  {
    id: "rail.log.page-activity",
    label: "{projectLabel} Activity Log",
    anchors: [
      msg(
        LOG,
        "project.history.log.title",
        'defaultMessage="{projectLabel} Activity Log"',
      ),
      ren(LOG, "intl.formatMessage(labels.project)"),
      msg(COMMON, "labels.workspace", 'defaultMessage: "Project"'),
    ],
    usedIn: [conventions("Project Activity Log")],
  },
  {
    id: "rail.log.flyout",
    label: "Recent",
    anchors: [
      msg(COMMON, "labels.recent", 'defaultMessage: "Recent"'),
      ren(
        "frontend/project/page/flyouts/log-header.tsx",
        "intl.formatMessage(labels.recent)",
      ),
      ren(FILE_TAB, "label: labels.log,"),
    ],
    usedIn: [conventions("whose flyout is titled Recent")],
  },
  {
    id: "settings.page-title",
    label: "Project Settings",
    anchors: [
      def("frontend/project/settings/page-shell.tsx", "Project Settings <"),
    ],
    usedIn: [conventions("a page titled Project Settings")],
  },
  {
    id: "settings.flyout-title",
    label: "Status and Settings",
    anchors: [
      msg(
        FILE_TAB,
        "project.page.flyout.settings.title",
        'defaultMessage: "Status and Settings"',
      ),
    ],
    usedIn: [conventions("a flyout titled Status and Settings")],
  },
  {
    id: "settings.users-flyout",
    label: "Users",
    anchors: [
      msg(COMMON, "labels.users", 'defaultMessage: "Users"'),
      ren(FILE_TAB, "label: labels.users,"),
      ren(QUICK_NAV_DATA, "Object.keys(FIXED_PROJECT_TABS)"),
    ],
    usedIn: [conventions("Quick Navigation opens as a flyout titled Users")],
    aliases: ["Users tab"],
  },
  {
    id: "settings.people",
    label: "People",
    anchors: [
      def(SECTIONS, 'label: "People",'),
      def(SECTIONS, 'id: "people",'),
    ],
    usedIn: [conventions("the People section of project settings")],
  },
  {
    id: "quick-navigation",
    label: "Quick Navigation",
    anchors: [
      msg(
        "frontend/app/quick-navigation/dialog.tsx",
        "quick-nav.title",
        'defaultMessage: "Quick Navigation"',
      ),
    ],
    usedIn: [conventions("Quick Navigation"), { file: doc("docs") }],
  },

  // Top navigation and hosts
  {
    id: "nav.compute",
    label: "Compute",
    anchors: [
      def(APP_PAGE, 'label="Compute"'),
      def(APP_PAGE, 'ariaLabel="Compute"'),
      def(APP_PAGE, "hide_label"),
      ren(QUICK_NAV_DATA, 'title: "Compute",'),
    ],
    usedIn: [
      conventions("its accessible name is Compute"),
      conventions("Quick Navigation lists the same page as Compute"),
      { file: doc("docs"), text: "(Projects, Compute," },
    ],
    aliases: ["Compute hosts"],
  },
  {
    id: "nav.compute-tooltip",
    label: "Manage project hosts and virtual machines",
    anchors: [
      def(APP_PAGE, 'tooltip="Manage project hosts and virtual machines"'),
    ],
    usedIn: [conventions("tooltip Manage project hosts and virtual machines")],
  },
  {
    id: "hosts.page-tabs",
    label: "Project Hosts",
    anchors: [def("frontend/hosts/hosts-page.tsx", 'label: "Project Hosts"')],
    usedIn: [conventions("the tabs Project Hosts and Virtual Machines")],
  },
  {
    id: "hosts.vms-tab",
    label: "Virtual Machines",
    anchors: [
      def("frontend/hosts/hosts-page.tsx", 'label: "Virtual Machines"'),
    ],
    usedIn: [
      conventions("the tabs Project Hosts and Virtual Machines"),
      bold("projects", "Virtual Machines"),
    ],
  },
  {
    id: "hosts.exams-tab",
    label: "Exams",
    anchors: [def(HOST_DRAWER, 'label: "Exams",')],
    usedIn: [
      conventions("Exams tab of a project host"),
      bold("hosts", "Exams"),
    ],
    aliases: ["instructor panel"],
  },
  ...(
    [
      ["overview", "Overview"],
      ["runtime", "Runtime"],
      ["storage", "Storage"],
      ["access", "Access"],
      ["reliability", "Reliability"],
    ] as const
  ).map(
    ([key, label]): UiVocabularyEntry => ({
      id: `hosts.drawer-tab.${key}`,
      label,
      anchors: [
        def(HOST_DRAWER, `key: "${key}",`),
        def(HOST_DRAWER, `label: "${label}",`),
      ],
      usedIn: [{ file: doc("hosts"), text: label }],
    }),
  ),
  {
    id: "hosts.project-resource-policy",
    label: "Project resource policy",
    anchors: [def(HOST_DRAWER, '"Project resource policy"')],
    usedIn: [bold("hosts", "Project resource policy")],
  },
  ...(
    [
      "Maximum run (minutes)",
      "Cleanup grace (minutes)",
      "Practice mode: erase projects manually (no automatic timeout)",
      "Refresh status",
    ] as const
  ).map(
    (label): UiVocabularyEntry => ({
      id: `hosts.exam.${label.toLowerCase().replace(/[^a-z]+/g, "-")}`,
      label,
      anchors: [def(EXAM_PANEL, label)],
      usedIn: [bold("hosts", label)],
    }),
  ),

  // Sign-in wording
  {
    id: "auth.sign-in-link",
    label: "Sign in",
    anchors: [msg(APP_PAGE, "page.sign_in.label", 'defaultMessage: "Sign in"')],
    usedIn: [conventions("the Sign in link in the top navigation")],
    aliases: ["login page"],
  },
  {
    id: "auth.sign-in-button",
    label: "Sign In",
    anchors: [def("frontend/public/auth/forms.tsx", '"Sign In"')],
    usedIn: [conventions("the Sign In button on the sign-in form")],
  },
  {
    id: "auth.sign-in-heading",
    label: "Sign in to {siteName}",
    anchors: [def(AUTH_APP, "`Sign in to ${siteName}`")],
    usedIn: [conventions("such as Sign in to CoCalc")],
  },
  {
    id: "auth.cli-approval-heading",
    label: "Approve sign-in for {siteName}",
    anchors: [def(AUTH_APP, "`Approve sign-in for ${siteName}`")],
    usedIn: [conventions("whose heading says sign-in")],
  },
  ...(
    [
      "Approve CLI Login",
      "Approve Mobile App Login",
      "Approve Elevated CLI Login",
    ] as const
  ).map(
    (label): UiVocabularyEntry => ({
      id: `auth.cli-approval.${label.toLowerCase().replace(/[^a-z]+/g, "-")}`,
      label,
      anchors: [def(CLI_AUTH, `"${label}"`)],
      usedIn: [conventions(label)],
    }),
  ),
  {
    id: "auth.please-login",
    label: "Please login to {siteName}",
    anchors: [
      def("frontend/components/login-link.tsx", "login to <SiteName />"),
    ],
    usedIn: [conventions("the Please login to prompt")],
  },
  {
    id: "codex.start-device-login",
    label: "Start device login",
    anchors: [
      def(
        "frontend/account/codex-credentials-panel.tsx",
        "> Start device login <",
      ),
    ],
    usedIn: [conventions("the Start device login button")],
  },

  // Git
  {
    id: "git.browser",
    label: "Git browser",
    anchors: [
      def("frontend/chat/chatroom-thread-menu.tsx", 'label: "Git browser",'),
      def("frontend/chat/git-commit/drawer-sections.tsx", "> Git browser <"),
    ],
    usedIn: [conventions("Use the name Git browser"), { file: doc("files") }],
    aliases: ["Git viewer"],
  },
  {
    id: "git.browser.timetravel",
    label: "Git Browser",
    anchors: [
      def(
        "frontend/frame-editors/time-travel-editor/time-travel.tsx",
        "> Git Browser <",
      ),
    ],
    usedIn: [conventions("TimeTravel has a Git Browser button")],
  },
  {
    id: "git.browser.open",
    label: "Open git browser",
    anchors: [
      def(
        "frontend/chat/chatroom-thread-panel.tsx",
        'aria-label="Open git browser"',
      ),
      def("frontend/chat/message.tsx", 'title="Open git browser"'),
      def("frontend/chat/agent-message-status.tsx", "> Open git browser <"),
    ],
    usedIn: [conventions("chat buttons and tooltips say Open git browser")],
  },

  // Terminals and new files
  {
    id: "new.button",
    label: "New",
    anchors: [
      msg(COMMON, "labels.new.file", 'defaultMessage: "New"'),
      ren(FILE_TAB, "label: labels.new,"),
      ren(
        "frontend/project/explorer/new-button.tsx",
        "intl.formatMessage(labels.new)",
      ),
    ],
    usedIn: [bold("terminal", "New")],
  },
  {
    id: "new.terminal",
    label: "Terminal",
    anchors: [
      def("frontend/project/new/launcher-catalog.ts", 'id: "term",'),
      def("frontend/project/new/launcher-catalog.ts", 'label: "Terminal",'),
    ],
    usedIn: [bold("terminal", "Terminal")],
  },

  // Jupyter
  {
    id: "jupyter.frame-menu",
    label: "Jupyter",
    anchors: [
      def(JUPYTER_EDITOR, 'short: "Jupyter",'),
      def(JUPYTER_EDITOR, 'name: "Jupyter Notebook",'),
    ],
    usedIn: [bold("jupyter", "Jupyter")],
  },
  {
    id: "jupyter.change-type",
    label: "Change Type",
    anchors: [
      msg(
        "frontend/frame-editors/frame-tree/commands/generic-commands.tsx",
        "command.generic.frame_type.label",
        'defaultMessage: "Change Type"',
      ),
    ],
    usedIn: [
      {
        file: doc("jupyter"),
        text: "**Change Type → Jupyter Studio (experimental)**",
      },
    ],
  },
  {
    id: "jupyter.studio-frame-type",
    label: "Jupyter Studio (experimental)",
    anchors: [
      def(JUPYTER_EDITOR, 'short: "Studio",'),
      def(JUPYTER_EDITOR, 'name: "Jupyter Studio (experimental)",'),
    ],
    usedIn: [{ file: doc("jupyter") }],
  },
  {
    id: "jupyter.return-to-classic",
    label: "Return to classic",
    anchors: [
      def(STUDIO_TOGGLE, 'okText="Return to classic"'),
      def(STUDIO_TOGGLE, "> Studio <"),
    ],
    usedIn: [bold("jupyter", "Return to classic"), bold("jupyter", "Studio")],
  },
  {
    id: "jupyter.toggle-studio",
    label: "Toggle Studio Notebook View",
    anchors: [
      msg(
        JUPYTER_COMMANDS,
        "jupyter.commands.toggle_studio_view.label",
        'defaultMessage: "Toggle Studio Notebook View"',
      ),
    ],
    usedIn: [bold("jupyter", "Toggle Studio Notebook View")],
    aliases: ["Switch to Studio Notebook View"],
  },
  {
    id: "jupyter.commands-dialog",
    label: "All Keyboard Shortcuts and Commands...",
    anchors: [
      msg(
        JUPYTER_COMMANDS,
        "jupyter.commands.edit_keyboard_shortcuts.label",
        'defaultMessage: "All Keyboard Shortcuts and Commands..."',
      ),
      ren(JUPYTER_EDITOR, 'keyboard: ["edit keyboard shortcuts"],'),
    ],
    usedIn: [{ file: doc("jupyter") }],
  },
  {
    id: "jupyter.studio.reading",
    label: "Reading",
    anchors: [def(STUDIO_CONTROLS, 'READING_MODE_LABEL = "Reading"')],
    usedIn: [bold("jupyter", "Reading")],
  },
  {
    id: "jupyter.studio.full-width",
    label: "Full width",
    anchors: [def(STUDIO_CONTROLS, 'title="Full width"')],
    usedIn: [bold("jupyter", "Full width")],
  },
  {
    id: "jupyter.run-all-above",
    label: "Run All Above Selected Cell",
    anchors: [
      msg(
        COMMON,
        "jupyter.commands.run_all_cells_above.menu",
        'defaultMessage: "Run All Above Selected Cell"',
      ),
    ],
    usedIn: [bold("jupyter", "Run All Above Selected Cell")],
  },
  {
    id: "jupyter.run-all-below",
    label: "Run Selected Cell and All Below",
    anchors: [
      msg(
        COMMON,
        "jupyter.commands.run_all_cells_below.menu",
        'defaultMessage: "Run Selected Cell and All Below"',
      ),
    ],
    usedIn: [bold("jupyter", "Run Selected Cell and All Below")],
  },
  {
    id: "jupyter.agent.target-language",
    label: "Target language",
    anchors: [
      msg(
        "frontend/jupyter/ai/agent-cell-tool.tsx",
        "jupyter.ai.cell-tool.prompt.translate",
        'defaultMessage: "Target language"',
      ),
    ],
    usedIn: [bold("jupyter", "Target language")],
  },

  // Virtual machines
  ...(
    [
      ["connect", "Connect", "> Connect <"],
      ["manage-account-vms", "Manage account VMs", "> Manage account VMs <"],
      ["stop", "Stop", "> Stop <"],
      ["start", "Start", "> Start <"],
      ["manage", "Manage", ">Manage<"],
      [
        "change-deletion-deadline",
        "Change deletion deadline",
        '"Change deletion deadline"',
      ],
    ] as const
  ).map(
    ([key, label, text]): UiVocabularyEntry => ({
      id: `vms.${key}`,
      label,
      anchors: [def(VMS, text)],
      // The docs name the Manage menu only through its items, as "Manage > …".
      usedIn: [
        key === "manage"
          ? { file: doc("projects"), text: "**Manage > " }
          : bold("projects", label),
      ],
    }),
  ),
  ...(
    [
      ["set-deletion-deadline", "Set deletion deadline"],
      ["change-machine-type", "Change machine type"],
      ["create-similar", "Create similar"],
      ["change-funding", "Change funding"],
      ["delete-vm", "Delete VM"],
    ] as const
  ).map(
    ([key, label]): UiVocabularyEntry => ({
      id: `vms.${key}`,
      label,
      anchors: [def(VMS, `"${label}"`)],
      usedIn: [{ file: doc("projects"), text: `Manage > ${label}` }],
    }),
  ),

  // Admin, account, collaboration and course
  ...(
    [
      ["user-search", "User Search"],
      ["site-licenses", "Site Licenses"],
    ] as const
  ).map(
    ([key, label]): UiVocabularyEntry => ({
      id: `admin.${key}`,
      label,
      anchors: [def(ADMIN_PAGE, `"${label}"`)],
      usedIn: [bold("admin", label)],
    }),
  ),
  {
    id: "admin.rootfs-images",
    label: "RootFS Images",
    anchors: [def(ADMIN_PAGE, '"RootFS Images"')],
    usedIn: [
      conventions("the RootFS Images admin page"),
      {
        file: entries("admin"),
        text: "Open the Admin -> RootFS Images section.",
      },
    ],
  },
  {
    id: "admin.customers.views",
    label: "Views",
    anchors: [def("frontend/admin/customers/index.tsx", ">Views<")],
    usedIn: [bold("admin", "Views")],
  },
  {
    id: "admin.outreach.view-observed",
    label: "View observed, no reply",
    anchors: [
      def("frontend/admin/customers/outreach.tsx", '"View observed, no reply"'),
    ],
    usedIn: [{ file: doc("admin") }],
  },
  ...(
    [
      ["account-id", "Account ID"],
      ["created", "Created"],
    ] as const
  ).map(
    ([key, label]): UiVocabularyEntry => ({
      id: `account.profile.${key}`,
      label,
      anchors: [
        def("frontend/account/settings/account-settings.tsx", `"${label}"`),
      ],
      usedIn: [bold("account", label)],
    }),
  ),
  {
    id: "collaborators.viewer-file-access",
    label: "Viewer file access",
    anchors: [
      def(
        "frontend/collaborators/viewer-read-policy.tsx",
        "Viewer file access",
      ),
    ],
    usedIn: [bold("research", "Viewer file access")],
  },
  {
    id: "editor.build-log",
    label: "Build Log",
    anchors: [
      def("frontend/frame-editors/qmd-editor/editor.ts", '"Build Log"'),
      def("frontend/frame-editors/rmd-editor/editor.ts", '"Build Log"'),
    ],
    usedIn: [
      bold("files", "Build Log"),
      bold("research-specialist", "Build Log"),
    ],
  },
  {
    id: "course.no-matching-license",
    label: "No matching site license found",
    anchors: [
      def(
        "frontend/course/configuration/student-pay.tsx",
        '"No matching site license found"',
      ),
    ],
    usedIn: [bold("teaching", "No matching site license found")],
  },
  {
    id: "course.create-shared-project",
    label: "Create Shared Project",
    anchors: [
      msg(
        COMMON,
        "course.create_shared_project",
        'defaultMessage: "Create Shared Project"',
      ),
    ],
    usedIn: [bold("teaching", "Create Shared Project")],
  },
];

const USERS_RETIRED =
  "Commit c2c669576c retired the Users rail entry so that project Settings is the single place to manage collaborators. The support conventions (conat/hub/api/admin-support.ts) say there is no Users tab on the left rail and that Quick Navigation opens Users as a flyout. Reversing the retirement needs the maintainer's agreement; if it happens, update those rules and the collaborator documentation.";

export const UI_VOCABULARY_FACTS: readonly UiVocabularyFact[] = [
  {
    id: "rail.users-retirement-test",
    file: "frontend/project/page/activity-bar-preferences.test.ts",
    kind: "present",
    text: "drops the retired users tab from stored activity bar preferences",
    reason: USERS_RETIRED,
  },
  {
    id: "rail.users-not-in-default-order",
    file: "frontend/project/page/activity-bar-preferences.ts",
    kind: "absent-between",
    after: "const DEFAULT_ORDER",
    before: "] as const;",
    text: '"users"',
    reason: USERS_RETIRED,
  },
];

export const UI_VOCABULARY_ALIAS_EXCEPTIONS: readonly UiVocabularyAliasException[] =
  [
    {
      file: doc("files"),
      line: "The file explorer is the project file browser.",
      reason:
        "Describes the Files page in a section whose naming (Files or file explorer) awaits a product decision.",
    },
    {
      file: entries("files"),
      line: "A project file browser with folders, file types, and search",
      reason:
        "Summary of the same entry, whose naming awaits the same product decision.",
    },
  ];
