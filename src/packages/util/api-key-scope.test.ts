import {
  apiKeyScopeAllows,
  legacyApiKeyScope,
  normalizeApiKeyScopeV1,
  viewerPolicyForApiKeyGrant,
} from "./api-key-scope";
import { viewerReadPolicyAllowsPath } from "./project-access";

const B = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";

test("empty drafts require explicit opt-in and cannot become active key scopes", () => {
  const empty = { version: 1, account: [], projects: [] };
  const draft = normalizeApiKeyScopeV1(empty, { allowEmpty: true });
  expect(draft).toEqual(empty);
  expect(apiKeyScopeAllows(draft, "project:list")).toBe(false);
  expect(apiKeyScopeAllows(draft, "file:read", B)).toBe(false);
  expect(() => normalizeApiKeyScopeV1(draft)).toThrow(
    "at least one capability",
  );
  expect(() =>
    normalizeApiKeyScopeV1({ ...empty, surprise: true }, { allowEmpty: true }),
  ).toThrow("unknown scope field");
  expect(() =>
    normalizeApiKeyScopeV1(
      { ...empty, account: ["invalid"] },
      { allowEmpty: true },
    ),
  ).toThrow("invalid account capability");
});

test("all-projects defaults preserve explicit restrictions and account separation", () => {
  const scope = normalizeApiKeyScopeV1({
    version: 1,
    account: [],
    all_projects: { capabilities: ["file:read", "project:exec", "file:write"] },
    projects: [
      {
        project_id: C,
        capabilities: ["file:read"],
        viewer_read_roots: ["assignments"],
      },
    ],
  });
  expect(apiKeyScopeAllows(scope, "project:exec", B)).toBe(true);
  expect(apiKeyScopeAllows(scope, "project:exec", C)).toBe(false);
  expect(apiKeyScopeAllows(scope, "project:list")).toBe(false);
  const policy = viewerPolicyForApiKeyGrant(scope, C);
  expect(
    viewerReadPolicyAllowsPath({ policy, path: "assignments/work.txt" }),
  ).toBe(true);
  expect(viewerReadPolicyAllowsPath({ policy, path: "outside.txt" })).toBe(
    false,
  );
  expect(normalizeApiKeyScopeV1(scope)).toEqual(scope);
});

test("all-projects viewer policy uses the same path and capability validation", () => {
  const base = { version: 1, account: [], projects: [] };
  const scope = normalizeApiKeyScopeV1({
    ...base,
    all_projects: { capabilities: ["file:read"], viewer_read_roots: ["."] },
  });
  expect(apiKeyScopeAllows(scope, "file:write", B)).toBe(false);
  expect(
    viewerReadPolicyAllowsPath({
      policy: viewerPolicyForApiKeyGrant(scope, B),
      path: ".ssh/id_rsa",
    }),
  ).toBe(false);
  for (const grant of [
    { capabilities: ["project:list"] },
    { capabilities: ["file:read"] },
    { capabilities: ["file:read"], viewer_read_roots: ["../secret"] },
    { capabilities: ["project:exec"], viewer_read_roots: ["."] },
    { capabilities: ["project:exec"], unknown: true },
  ])
    expect(() =>
      normalizeApiKeyScopeV1({ ...base, all_projects: grant }),
    ).toThrow();
});

test("mixed project privileges remain independent and canonical", () => {
  const scope = normalizeApiKeyScopeV1({
    version: 1,
    account: ["project:list", "project:list"],
    projects: [
      {
        project_id: C,
        capabilities: ["file:read", "project:read"],
        viewer_read_roots: ["data", "notes"],
      },
      { project_id: B, capabilities: ["project:exec", "file:write"] },
    ],
  });
  expect(scope.projects.map(({ project_id }) => project_id)).toEqual([B, C]);
  expect(apiKeyScopeAllows(scope, "project:exec", B)).toBe(true);
  expect(apiKeyScopeAllows(scope, "project:exec", C)).toBe(false);
  expect(apiKeyScopeAllows(scope, "file:read", C)).toBe(true);
  expect(apiKeyScopeAllows(scope, "file:read", B)).toBe(false);
  expect(apiKeyScopeAllows(scope, "project:list")).toBe(true);
  const policy = viewerPolicyForApiKeyGrant(scope, C);
  expect(viewerReadPolicyAllowsPath({ policy, path: "data/a.txt" })).toBe(true);
  expect(viewerReadPolicyAllowsPath({ policy, path: "database/a.txt" })).toBe(
    false,
  );
  expect(viewerReadPolicyAllowsPath({ policy, path: ".ssh/id_rsa" })).toBe(
    false,
  );
});

test("legacy capability and allowlist product keeps its meaning", () => {
  const scope = legacyApiKeyScope({
    capabilities: ["project:list", "project:exec"],
    allowed_project_ids: [B, C],
  });
  expect(apiKeyScopeAllows(scope, "project:list")).toBe(true);
  expect(apiKeyScopeAllows(scope, "project:exec", B)).toBe(true);
  expect(apiKeyScopeAllows(scope, "project:exec", C)).toBe(true);
  expect(
    legacyApiKeyScope({
      capabilities: ["project:list"],
      allowed_project_ids: [B],
    }).projects,
  ).toEqual([]);
});

test("rejects ambiguous and dangerous grants", () => {
  const base = { version: 1, account: [], projects: [] };
  expect(() => normalizeApiKeyScopeV1(base)).toThrow();
  expect(() =>
    normalizeApiKeyScopeV1({
      ...base,
      projects: [
        {
          project_id: B,
          capabilities: ["file:read"],
          viewer_read_roots: ["."],
        },
        { project_id: B, capabilities: ["project:exec"] },
      ],
    }),
  ).toThrow(/duplicate/);
  expect(() =>
    normalizeApiKeyScopeV1({
      ...base,
      projects: [{ project_id: B, capabilities: ["project:list"] }],
    }),
  ).toThrow(/not valid for project/);
  for (const path of ["../secret", "/home/user", "foo/**", ".ssh", "a//b"]) {
    expect(() =>
      normalizeApiKeyScopeV1({
        ...base,
        projects: [
          {
            project_id: B,
            capabilities: ["file:read"],
            viewer_read_roots: [path],
          },
        ],
      }),
    ).toThrow();
  }
  expect(() =>
    normalizeApiKeyScopeV1({
      ...base,
      projects: [
        {
          project_id: B,
          capabilities: ["file:read", "project:exec"],
          viewer_read_roots: ["data"],
        },
      ],
    }),
  ).toThrow(/broader grants/);
});
