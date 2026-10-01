import {
  getInitialAccountPageState,
  getPageTargetPath,
  getPageTopTab,
  getPageUrlPath,
  parsePageTarget,
} from "./page-routing";

describe("page-routing", () => {
  it.each([
    "u/alice/agents/reviewer",
    "u/alice/artifacts/notes",
    "u/11111111-1111-4111-8111-111111111111/chats/team",
    "u/alice/people/bella",
    "u/alice/artifacts/notes/extra",
    "u//agents/reviewer",
    "u/alice/chats/%2F",
    "u/alice/chats/%",
  ])("keeps %s separate from all viewer-local aliases", (target) => {
    const parsed = parsePageTarget(`${target}?view=grid#details`);
    expect(parsed).toEqual({ page: "agents", personal_url: target });
    expect(getPageUrlPath(parsed)).toBe(`/${target}`);
    expect(getPageTopTab(parsed)).toBe("agents");
  });

  it("qualifies personal links but not collections or the new-agent action", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(
      getPageUrlPath({ page: "agents", owner: "alice", agent_id: id }),
    ).toBe(`/agents/${id}`);
    expect(
      getPageUrlPath({ page: "agents", owner: "alice", agent_id: "reviewer" }),
    ).toBe("/u/alice/agents/reviewer");
    expect(
      getPageUrlPath({
        page: "agents",
        owner: "alice",
        library: true,
        artifact_project_id: "notes",
      }),
    ).toBe("/u/alice/artifacts/notes");
    expect(getPageUrlPath({ page: "agents", owner: "alice" })).toBe("/agents");
    expect(
      getPageUrlPath({ page: "agents", owner: "alice", agent_id: "new" }),
    ).toBe("/agents/new");
    expect(
      getPageUrlPath({ page: "agents", owner: "alice", library: true }),
    ).toBe("/artifacts");
  });

  it("unqualified agent names never become a viewer-local selection", () => {
    expect(parsePageTarget("agents/reviewer")).toEqual({
      page: "agents",
      personal_url: "agents/reviewer",
    });
  });
  it("opens Home as the agent workspace", () => {
    expect(parsePageTarget("home")).toEqual(parsePageTarget("agents"));
    expect(parsePageTarget("home/")).toEqual(parsePageTarget("agents"));
  });
  it("maps settings routes to the account top tab", () => {
    const parsed = parsePageTarget("settings/payment-methods");
    expect(parsed).toEqual({
      page: "account",
      tab: "payment-methods",
    });
    expect(getPageTopTab(parsed)).toBe("account");
    expect(getInitialAccountPageState(parsed)).toEqual({
      active_page: "payment-methods",
    });
  });

  it("keeps projects and project targets distinct", () => {
    expect(parsePageTarget("projects")).toEqual({ page: "projects" });
    expect(parsePageTarget("projects/abc/files")).toEqual({
      page: "project",
      target: "abc/files",
    });
  });

  it("parses and formats My Agents targets", () => {
    expect(parsePageTarget("agents")).toEqual({
      page: "agents",
      agent_id: undefined,
    });
    const parsed = parsePageTarget(
      "agents/11111111-1111-4111-8111-111111111111",
    );
    expect(parsed).toEqual({
      page: "agents",
      agent_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(getPageTopTab(parsed)).toBe("agents");
    expect(getPageTargetPath(parsed)).toBe(
      "agents/11111111-1111-4111-8111-111111111111",
    );

    const create = parsePageTarget("agents/new");
    expect(create).toEqual({ page: "agents", agent_id: "new" });
    expect(getPageUrlPath(create)).toBe("/agents/new");

    expect(
      parsePageTarget(
        "agents/11111111-1111-4111-8111-111111111111?network=legacy-filter",
      ),
    ).toEqual({
      page: "agents",
      agent_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("parses auth and ssh routes explicitly", () => {
    expect(parsePageTarget("auth/password-reset")).toEqual({
      page: "auth",
      view: "password-reset",
    });
    expect(parsePageTarget("ssh")).toEqual({ page: "ssh" });
  });

  it.each(["artifacts", "artifacts/nb1", "artifacts/project-123/entry-456"])(
    "roundtrips %s through the agents top tab",
    (target) => {
      const parsed = parsePageTarget(target);
      expect(parsed).toEqual({
        page: "agents",
        library: true,
        artifact_project_id: target.split("/")[1],
        artifact_entry_id: target.split("/")[2],
      });
      expect(getPageTopTab(parsed)).toBe("agents");
      expect(getPageTargetPath(parsed)).toBe(target);
      expect(getPageUrlPath(parsed)).toBe(`/${target}`);
      expect(parsePageTarget(`${target}?view=grid#details`)).toEqual(parsed);
    },
  );

  it.each(["library", "library/sphere", "library/project/entry"])(
    "does not route removed library URL %s to artifacts",
    (target) => {
      expect(parsePageTarget(target)).toEqual({
        page: "account",
        tab: "index",
      });
    },
  );

  it("normalizes the Artifacts root trailing slash without selecting an agent", () => {
    expect(parsePageTarget("artifacts/")).toEqual(parsePageTarget("artifacts"));
    expect(
      getPageUrlPath({ page: "agents", library: true, agent_id: "prior" }),
    ).toBe("/artifacts");
  });

  it.each([
    "artifacts//entry",
    "artifacts/project/",
    "artifacts/project/entry/extra",
    "artifacts/project/entry/",
    "artifacts///",
  ])("retains malformed suffixes for not-found handling: %s", (target) => {
    const parsed = parsePageTarget(target);
    expect(parsed.page).toBe("agents");
    expect(getPageTargetPath(parsed)).toBe(target);
    expect(parsed).not.toEqual(parsePageTarget("artifacts/project/entry"));
  });

  it("parses site-license claim routes explicitly", () => {
    const parsed = parsePageTarget("claim/site-license?token=abc");
    expect(parsed).toEqual({
      page: "claim",
      kind: "site-license",
    });
    expect(getPageTopTab(parsed)).toBe("claim");
    expect(getPageUrlPath(parsed)).toBe("/claim/site-license");
  });

  it("parses global docs routes", () => {
    expect(parsePageTarget("app-docs")).toEqual({ page: "docs" });
    expect(parsePageTarget("app-docs/admin/users")).toEqual({
      page: "docs",
      slug: "admin/users",
    });
    expect(parsePageTarget("app-docs/print")).toEqual({
      page: "docs",
      print: true,
    });
    expect(getPageTopTab(parsePageTarget("app-docs/admin/users"))).toBe("docs");
  });

  it("preserves direct public share file paths", () => {
    expect(parsePageTarget("share/test2/a.chat")).toEqual({
      page: "share",
      slug: "test2/a.chat",
    });
    expect(getPageUrlPath({ page: "share", slug: "test2/a.chat" })).toBe(
      "/share/test2/a.chat",
    );
  });

  it("parses admin subroutes and ignores query strings", () => {
    expect(parsePageTarget("admin/news")).toEqual({
      page: "admin",
      route: { kind: "news-list" },
    });
    expect(parsePageTarget("admin/news/new?channel=event")).toEqual({
      page: "admin",
      route: { kind: "news-editor", id: "new" },
    });
  });

  it("normalizes settings overview and preferences routes", () => {
    expect(parsePageTarget("settings")).toEqual({
      page: "account",
      tab: "index",
    });
    expect(parsePageTarget("settings/profile")).toEqual({
      page: "account",
      tab: "profile",
    });
    expect(parsePageTarget("settings/editor")).toEqual({
      page: "account",
      tab: "editor",
    });
    expect(parsePageTarget("settings/billing")).toEqual({
      page: "account",
      tab: "index",
    });
  });

  it("maps legacy billing and membership store aliases onto canonical settings pages", () => {
    expect(parsePageTarget("billing/cards")).toEqual({
      page: "account",
      tab: "payment-methods",
    });
    expect(parsePageTarget("billing/receipts")).toEqual({
      page: "account",
      tab: "statements",
    });
    expect(parsePageTarget("store/membership")).toEqual({
      page: "account",
      tab: "membership",
    });
    expect(parsePageTarget("store/checkout")).toEqual({
      page: "account",
      tab: "membership",
    });
  });

  it("builds canonical paths from shared page routes", () => {
    expect(getPageTargetPath({ page: "projects" })).toBe("projects");
    expect(
      getPageTargetPath({
        page: "account",
        tab: "keyboard",
      }),
    ).toBe("settings/keyboard");
    expect(getPageUrlPath({ page: "auth", view: "sign-up" })).toBe(
      "/auth/sign-up",
    );
    expect(getPageUrlPath({ page: "docs", slug: "admin/users" })).toBe(
      "/app-docs/admin/users",
    );
    expect(getPageUrlPath({ page: "docs", print: true })).toBe(
      "/app-docs/print",
    );
    expect(
      getPageUrlPath({
        page: "admin",
        route: { kind: "news-editor", id: "17" },
      }),
    ).toBe("/admin/news/17");
    expect(getPageUrlPath({ page: "project", target: "abc/files" })).toBe(
      "/projects/abc/files",
    );
  });
});
