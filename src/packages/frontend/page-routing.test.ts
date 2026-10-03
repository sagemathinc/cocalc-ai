import {
  getInitialAccountPageState,
  getPageTargetPath,
  getPageTopTab,
  getPageUrlPath,
  parsePageTarget,
  personalProjectPath,
} from "./page-routing";
import {
  setMyProjectAliases,
  setPersonalUrlIdentity,
} from "./app/personal-url-identity";

describe("page-routing", () => {
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
    const parsed = parsePageTarget("agents/agent-123");
    expect(parsed).toEqual({ page: "agents", agent_id: "agent-123" });
    expect(getPageTopTab(parsed)).toBe("agents");
    expect(getPageTargetPath(parsed)).toBe("agents/agent-123");

    const create = parsePageTarget("agents/new");
    expect(create).toEqual({ page: "agents", agent_id: "new" });
    expect(getPageUrlPath(create)).toBe("/agents/new");

    expect(parsePageTarget("agents/agent-123?network=legacy-filter")).toEqual({
      page: "agents",
      agent_id: "agent-123",
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

  it("normalizes the Library root trailing slash without selecting an agent", () => {
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

  it("round-trips People routes", () => {
    expect(parsePageTarget("people")).toEqual({ page: "people" });
    const route = "conversations/p1/c1";
    expect(parsePageTarget(`people/${route}`)).toEqual({
      page: "people",
      route,
    });
    expect(getPageUrlPath({ page: "people", route })).toBe(`/people/${route}`);
    expect(getPageUrlPath({ page: "people" })).toBe("/people");
  });
});

test("personal URLs round-trip and show People while resolving", () => {
  const parsed = parsePageTarget("u/alice/chats/weekly");
  expect(parsed).toEqual({ page: "u", path: "u/alice/chats/weekly" });
  expect(getPageUrlPath(parsed)).toBe("/u/alice/chats/weekly");
  expect(getPageTopTab(parsed)).toBe("people");
});

test("the Agents page has its own address and keeps the agents tab", () => {
  const parsed = parsePageTarget("all-agents");
  expect(parsed).toEqual({ page: "agents", overview: true });
  expect(getPageUrlPath(parsed)).toBe("/all-agents");
  expect(getPageTopTab(parsed)).toBe("agents");
});

test("my named agents and artifacts have personal addresses; others' are resolved", () => {
  setPersonalUrlIdentity({ account_id: "acct-1", username: "wstein" });
  try {
    expect(getPageUrlPath({ page: "agents", agent_id: "agent-1" })).toBe(
      "/u/wstein/agents/agent-1",
    );
    expect(
      getPageUrlPath({
        page: "agents",
        library: true,
        artifact_project_id: "plan",
      }),
    ).toBe("/u/wstein/artifacts/plan");
    // Ids and new agents keep their own paths.
    expect(getPageUrlPath({ page: "agents", agent_id: "new" })).toBe(
      "/agents/new",
    );
    const id = "11111111-1111-4111-8111-111111111111";
    expect(getPageUrlPath({ page: "agents", agent_id: id })).toBe(
      `/agents/${id}`,
    );
    // Mine (by username or account id, any case) open directly.
    expect(parsePageTarget("u/wstein/agents/agent-1")).toEqual({
      page: "agents",
      agent_id: "agent-1",
    });
    expect(parsePageTarget("u/ACCT-1/artifacts/plan")).toEqual({
      page: "agents",
      library: true,
      artifact_project_id: "plan",
    });
    // Someone else's goes to the resolver.
    expect(parsePageTarget("u/alice/agents/helper")).toEqual({
      page: "u",
      path: "u/alice/agents/helper",
    });
  } finally {
    setPersonalUrlIdentity({});
  }
  // Without an identity the plain paths remain.
  expect(getPageUrlPath({ page: "agents", agent_id: "agent-1" })).toBe(
    "/agents/agent-1",
  );
});

test("projects I gave an alias have /u/<me>/projects/<alias> addresses", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  setPersonalUrlIdentity({ account_id: "acct-1", username: "wstein" });
  setMyProjectAliases([{ project_id: id, alias: "research" }]);
  try {
    expect(
      getPageUrlPath({ page: "project", target: `${id}/files/a/paper.tex` }),
    ).toBe("/u/wstein/projects/research/files/a/paper.tex");
    expect(personalProjectPath(`/projects/${id}/files/notes/`)).toBe(
      "/u/wstein/projects/research/files/notes/",
    );
    // Mine open directly, keeping a folder's trailing slash.
    expect(parsePageTarget("u/wstein/projects/Research/files/notes/")).toEqual({
      page: "project",
      target: `${id}/files/notes/`,
    });
    expect(parsePageTarget("u/wstein/projects/research")).toEqual({
      page: "project",
      target: id,
    });
    // Other projects and other people's aliases are unchanged / resolved.
    const other = "33333333-3333-4333-8333-333333333333";
    expect(getPageUrlPath({ page: "project", target: `${other}/files/` })).toBe(
      `/projects/${other}/files/`,
    );
    expect(parsePageTarget("u/alice/projects/research/files/x/")).toEqual({
      page: "u",
      path: "u/alice/projects/research/files/x/",
    });
  } finally {
    setMyProjectAliases([]);
    setPersonalUrlIdentity({});
  }
});

test("search results have their own address, over the page of their kind", () => {
  const parsed = parsePageTarget("search/projects/plot%20a%2Fb");
  expect(parsed).toEqual({
    page: "search",
    scope: "projects",
    query: "plot a/b",
  });
  expect(getPageUrlPath(parsed)).toBe("/search/projects/plot%20a%2Fb");
  expect(getPageTopTab(parsed)).toBe("projects");
  // Back/Forward hands over decoded paths: slashes in the query survive.
  expect(parsePageTarget("search/people/a/b")).toEqual({
    page: "search",
    scope: "people",
    query: "a/b",
  });
  expect(getPageTopTab(parsePageTarget("search/artifacts/x"))).toBe("agents");
  expect(parsePageTarget("search/bogus/x")).toMatchObject({ scope: "agents" });
});
test.each(["", "/", "/project/entry", "//entry", "/project/entry/extra"])(
  "legacy Library suffix %s resolves like Artifacts and generates its current address",
  (suffix) => {
    const parsed = parsePageTarget(`library${suffix}`);
    expect(parsed).toEqual(parsePageTarget(`artifacts${suffix}`));
    expect(getPageTargetPath(parsed)).toBe(
      getPageTargetPath(parsePageTarget(`artifacts${suffix}`)),
    );
  },
);
