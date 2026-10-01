import { collaboratorsTargetPath, parseCollaboratorsRoute } from "./routing";
import { getPageUrlPath, parsePageTarget } from "../page-routing";
import type { CollaboratorsView } from "./workspace-types";

const CONTACT = "33333333-3333-4333-8333-333333333333";

test("Invites deep links roundtrip their selected invitation and independent contact filter", () => {
  const route = {
    view: "invites" as const,
    contactId: CONTACT,
    invitationId: CONTACT,
  };
  const path = collaboratorsTargetPath(route);
  expect(path).toBe(
    `people/invites/contact/${CONTACT}?invitation_id=${CONTACT}`,
  );
  expect(parsePageTarget(path)).toEqual({
    page: "agents",
    collaborators: route,
  });
  expect(getPageUrlPath(parsePageTarget(path))).toBe(`/${path}`);
  expect(
    parsePageTarget(`people/invites/?invitation_id=${CONTACT}#details`),
  ).toEqual({
    page: "agents",
    collaborators: { view: "invites", invitationId: CONTACT },
  });
});

test.each(["", "bad", "%2F", "%00", `${CONTACT}&invitation_id=${CONTACT}`])(
  "invalid or ambiguous invitation selection fails closed: %s",
  (id) => {
    expect(parsePageTarget(`people/invites?invitation_id=${id}`)).toMatchObject(
      {
        collaborators: { routeError: expect.any(String) },
      },
    );
  },
);

test.each<CollaboratorsView>(["people", "projects", "conversations"])(
  "%s ignores invitation-only selection",
  (view) => {
    const path = collaboratorsTargetPath({ view, invitationId: CONTACT });
    expect(path).not.toContain("?");
    expect(parsePageTarget(`${path}?invitation_id=${CONTACT}`)).toEqual({
      page: "agents",
      collaborators: { view },
    });
  },
);

test.each<CollaboratorsView>(["people", "invites"])(
  "%s contact routes preserve contact identity separately from account people",
  (view) => {
    const route = { view, contactId: CONTACT };
    const target = `people/${view === "people" ? "collaborators" : view}/contact/${CONTACT}`;
    expect(collaboratorsTargetPath(route)).toBe(target);
    for (const suffix of ["", "/"]) {
      expect(parsePageTarget(`${target}${suffix}`)).toEqual({
        page: "agents",
        collaborators: route,
      });
    }
    expect(
      collaboratorsTargetPath({
        ...route,
        alias: "friend",
        aliasKind: "people",
        aliasOwner: "owner",
      }),
    ).toBe(target);
  },
);

test("Invites contact and project filters roundtrip independently", () => {
  const route = {
    view: "invites" as const,
    contactId: CONTACT,
    projectIds: ["11111111-1111-4111-8111-111111111111"],
  };
  expect(parsePageTarget(collaboratorsTargetPath(route))).toEqual({
    page: "agents",
    collaborators: route,
  });
});

test("unqualified chat aliases do not resolve in the viewer's namespace", () => {
  const parsed = parsePageTarget("chats/Alice-2");
  expect(parsed).toMatchObject({
    page: "agents",
    collaborators: {
      view: "conversations",
      routeError: expect.stringContaining("owner"),
    },
  });
  expect(parsePageTarget("chats")).toMatchObject({
    page: "agents",
    collaborators: { aliasKind: "chats" },
  });
});
test("People collection URLs are workspace views, not unqualified aliases", () => {
  for (const target of ["people", "people/", "people/conversations"]) {
    const parsed = parsePageTarget(target);
    expect(parsed).toEqual({
      page: "agents",
      collaborators: { view: "conversations" },
    });
    expect(getPageUrlPath(parsed)).toBe("/people/conversations");
  }
  expect(parsePageTarget("people/Alice-2")).toEqual({
    page: "agents",
    collaborators: { routeError: expect.any(String) },
  });
  expect(collaboratorsTargetPath({ view: "people", aliasKind: "people" })).toBe(
    "people/collaborators",
  );
});
test("qualified links use the alias owner, never a person/resource ID", () => {
  expect(
    collaboratorsTargetPath({
      view: "people",
      aliasOwner: "alice",
      aliasKind: "people",
      alias: "friend",
      personId: "bob",
    }),
  ).toBe("u/alice/people/friend");
  expect(
    collaboratorsTargetPath({
      view: "conversations",
      aliasOwner: "alice",
      aliasKind: "chats",
      alias: "team",
      projectId: "project",
      resourceKind: "conversation",
      resourceId: "thread",
    }),
  ).toBe("u/alice/chats/team");
  expect(
    collaboratorsTargetPath({
      view: "people",
      aliasKind: "people",
      alias: "friend",
      personId: "bob",
    }),
  ).toBe("people/collaborators/person/bob");
});

test.each(["friend", "collaborators", "invites", "people", "projects"])(
  "qualified People alias %s is never interpreted as a workspace view",
  (alias) => {
    for (const suffix of ["", "/"]) {
      const target = `u/owner/people/${alias}${suffix}`;
      const parsed = parsePageTarget(target);
      expect(parsed).toEqual({ page: "agents", personal_url: target });
      expect(getPageUrlPath(parsed)).toBe(`/${target}`);
    }
  },
);
test.each([
  "chats/a/b",
  "people/%2f",
  "people/%",
  "chats//alice",
  "people/..",
  "people/a%20b",
])("invalid private URL fails closed: %s", (target) => {
  const parsed = parsePageTarget(target);
  expect(parsed).toMatchObject({
    page: "agents",
    collaborators: { routeError: expect.any(String) },
  });
});

test("project and person scopes roundtrip with a stable resource identity", () => {
  const route = {
    view: "conversations" as const,
    projectId: "project-1",
    projectIds: [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ],
    personId: "person-1",
    resourceKind: "conversation" as const,
    resourceId: "thread-1",
  };
  const path = collaboratorsTargetPath(route);
  expect(path).toMatch(/^people\/conversations\//);
  expect(parseCollaboratorsRoute(path.split("/").slice(1))).toEqual(route);
  expect(parsePageTarget(path)).toEqual({
    page: "agents",
    collaborators: route,
  });
  expect(getPageUrlPath({ page: "agents", collaborators: route })).toBe(
    `/${path}`,
  );
});

test.each<[string, CollaboratorsView]>([
  ["collaborators", "people"],
  ["people", "people"],
  ["projects", "projects"],
  ["conversations", "conversations"],
  ["invites", "invites"],
])(
  "direct %s view accepts trailing slash and canonicalizes without a project",
  (segment, view) => {
    for (const suffix of ["", "/", "/?filter=all#details"]) {
      const parsed = parsePageTarget(`people/${segment}${suffix}`);
      expect(parsed).toEqual({ page: "agents", collaborators: { view } });
      const canonical = view === "people" ? "collaborators" : view;
      expect(getPageUrlPath(parsed)).toBe(`/people/${canonical}`);
    }
  },
);

test.each<CollaboratorsView>([
  "people",
  "projects",
  "conversations",
  "invites",
])(
  "%s scoped routes roundtrip with a trailing slash without mutating parts",
  (view) => {
    const route = {
      view,
      projectId: "project-1",
      personId: "person-1",
      resourceKind: "artifact" as const,
      resourceId: "folder/item",
    };
    const target = collaboratorsTargetPath(route);
    const parts = `${target}/`.split("/").slice(1);
    const original = [...parts];
    expect(parseCollaboratorsRoute(parts)).toEqual(route);
    expect(parts).toEqual(original);
    expect(parsePageTarget(`${target}/?source=copy#details`)).toEqual({
      page: "agents",
      collaborators: route,
    });
  },
);

test.each([
  ["collaborators", "people/conversations"],
  ["collaborators/", "people/conversations"],
  ["collaborators/conversations", "people/conversations"],
  ["collaborators/people/person/bob", "people/collaborators/person/bob"],
  ["people/people/person/bob/", "people/collaborators/person/bob"],
  ["people/people/", "people/collaborators"],
  [
    "collaborators/projects/project/project-1",
    "people/projects/project/project-1",
  ],
  [
    "collaborators/conversations/project/project-1/resource/artifact/folder%2Fitem",
    "people/conversations/project/project-1/resource/artifact/folder%2Fitem",
  ],
])("old workspace URL %s canonicalizes to %s", (legacy, canonical) => {
  const parsed = parsePageTarget(`${legacy}?view=grid#details`);
  expect(parsed).toEqual(parsePageTarget(canonical));
  expect(getPageUrlPath(parsed)).toBe(`/${canonical}`);
});

test("opaque resource identities roundtrip encoded slashes without changing routing", () => {
  const route = {
    view: "conversations" as const,
    projectId: "project-1",
    resourceKind: "artifact" as const,
    resourceId: 'artifact:["thread","folder/item"]',
  };
  const path = collaboratorsTargetPath(route);
  expect(path).toContain("%2F");
  expect(parsePageTarget(path)).toEqual({
    page: "agents",
    collaborators: route,
  });
});

test("root opens conversations and encoded labels do not become path segments", () => {
  expect(parseCollaboratorsRoute([])).toEqual({ view: "conversations" });
  expect(parseCollaboratorsRoute([""])).toEqual({ view: "conversations" });
  expect(parseCollaboratorsRoute(["people", "person", "a%20b"])).toEqual({
    view: "people",
    personId: "a b",
  });
});

test.each([
  ["unexpected"],
  ["invites", "contact", "account-not-contact"],
  ["collaborators", "contact", ""],
  ["collaborators", "contact", "%2F"],
  ["invites", "contact", CONTACT, "contact", CONTACT],
  ["", ""],
  ["collaborators", "", ""],
  ["invites", "", "person", "bob"],
  ["invites", "person", "bob", "", ""],
  ["collaborators", "person", "", ""],
  ["invites", "project", "one", "project", "two", ""],
  ["conversations", "resource", "conversation", "thread"],
  ["people", "person", ""],
  ["people", "person", "one", "person", "two"],
  ["people", "person", "%2F"],
  ["people", "person", "%"],
  ["conversations", "project", "one", "resource", "unknown", "thread"],
  ["conversations", "project", "one", "extra"],
])("malformed route stays invalid: %j", (...parts) => {
  const route = parseCollaboratorsRoute(parts);
  expect(route.routeError).toBeTruthy();
  expect(collaboratorsTargetPath(route)).toBe("people/invalid");
});

test("Scan Files has a reloadable canonical People address", () => {
  expect(collaboratorsTargetPath({ view: "scan-files" })).toBe(
    "people/scan-files",
  );
  expect(parseCollaboratorsRoute(["scan-files"])).toEqual({
    view: "scan-files",
  });
  expect(parsePageTarget("people/scan-files")).toMatchObject({
    collaborators: { view: "scan-files" },
  });
});
