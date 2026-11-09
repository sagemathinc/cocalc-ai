/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  canonicalJson,
  federationIssuer,
  gcloudLeaseStatusFile,
  isFederatedCliConnector,
  isGcpProjectId,
  isGcpServiceAccount,
  isSaLabel,
  parseFederatedConnectorTurnResult,
  parseFederatedGate,
  parseGcloudLeasesEnded,
  parseGcloudTurnToken,
  validateFederationAttributes,
  wifAssertionAudience,
  wifExchangeAudience,
  wifGrantPrincipalSet,
} from "./federated-connectors";
import { CLI_CONNECTORS } from "./cli-connectors";

// Fake values only.
const UUID = (n: number) =>
  `00000000-0000-4000-8000-${`${n}`.padStart(12, "0")}`;
const PROVIDER = {
  pool_project_number: "123456789012",
  pool_id: "example-pool",
  provider_id: "example-provider",
};
const TOKEN = "ya29.planted-token-value-0123456789";

function validEntry(): any {
  return {
    connector: "gcloud",
    token: TOKEN,
    expires_at: 1_800_000_000_000,
    description: "example read-only",
    gcloud: {
      provider_expires_at: 1_800_000_000_000,
      lease_max_expires_at: null,
      status: "active",
      project: "example-project-1",
      sa_label: "read-only",
      lease_id: UUID(1),
      connection_id: UUID(2),
      grant_revision: 1,
    },
  };
}

describe("federated connector kinds", () => {
  it("keeps gcloud out of the env-var CLI connectors", () => {
    expect(isFederatedCliConnector("gcloud")).toBe(true);
    expect((CLI_CONNECTORS as readonly string[]).includes("gcloud")).toBe(
      false,
    );
    expect(isFederatedCliConnector("github")).toBe(false);
  });
});

describe("identifier formats", () => {
  it("accepts project ids and refuses anything else", () => {
    expect(isGcpProjectId("example-project-1")).toBe(true);
    for (const bad of [
      "Example-project",
      "ab",
      "x".repeat(31),
      "project-",
      "1project",
      "proj;rm -rf",
      "project\n",
      "",
      42,
    ]) {
      expect(isGcpProjectId(bad)).toBe(false);
    }
  });

  it("accepts only project service accounts, never the default compute account", () => {
    expect(
      isGcpServiceAccount(
        "reader-sa@example-project-1.iam.gserviceaccount.com",
      ),
    ).toBe(true);
    expect(
      isGcpServiceAccount("123456789012-compute@developer.gserviceaccount.com"),
    ).toBe(false);
    expect(isGcpServiceAccount("reader-sa@example.com")).toBe(false);
  });

  it("sa labels are short labels, never emails", () => {
    expect(isSaLabel("read-only")).toBe(true);
    expect(
      isSaLabel("reader-sa@example-project-1.iam.gserviceaccount.com"),
    ).toBe(false);
    expect(isSaLabel("x".repeat(41))).toBe(false);
  });
});

describe("issuer and audiences", () => {
  it("builds the issuer from a bare https origin only", () => {
    expect(federationIssuer("https://staging.example.com")).toBe(
      "https://staging.example.com/_cocalc/oidc/connectors",
    );
    for (const bad of [
      "http://staging.example.com",
      "https://staging.example.com/path",
      "https://user:pw@staging.example.com",
      "https://staging.example.com?x=1",
      "not a url",
    ]) {
      expect(() => federationIssuer(bad)).toThrow();
    }
  });

  it("uses the https form for the assertion and the // form for the exchange", () => {
    const path =
      "iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/example-pool/providers/example-provider";
    expect(wifAssertionAudience(PROVIDER)).toBe(`https://${path}`);
    expect(wifExchangeAudience(PROVIDER)).toBe(`//${path}`);
  });

  it("refuses malformed provider parts before building an audience", () => {
    expect(() =>
      wifAssertionAudience({ ...PROVIDER, pool_id: "pool/../x" }),
    ).toThrow("invalid pool id");
    expect(() =>
      wifExchangeAudience({ ...PROVIDER, pool_project_number: "0123" }),
    ).toThrow("invalid pool project number");
  });

  it("binds exactly one grant id", () => {
    expect(
      wifGrantPrincipalSet({
        pool_project_number: "123456789012",
        pool_id: "example-pool",
        grant_id: UUID(3),
      }),
    ).toBe(
      `principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/example-pool/attribute.grant_id/${UUID(3)}`,
    );
    expect(() =>
      wifGrantPrincipalSet({
        pool_project_number: "123456789012",
        pool_id: "example-pool",
        grant_id: "*",
      }),
    ).toThrow("invalid grant id");
  });
});

describe("assertion attributes", () => {
  const attrs = () => ({
    site_id: UUID(1),
    account_id: UUID(2),
    agent_id: UUID(3),
    project_id: UUID(4),
    connection_id: UUID(5),
    grant_id: UUID(6),
    grant_revision: "1",
    lease_id: UUID(7),
  });

  it("accepts exactly the opaque id claims", () => {
    expect(validateFederationAttributes(attrs())).toEqual(attrs());
  });

  it("refuses emails, extra or missing claims and bad revisions", () => {
    expect(() =>
      validateFederationAttributes({ ...attrs(), account_id: "a@example.com" }),
    ).toThrow("account_id");
    expect(() =>
      validateFederationAttributes({ ...attrs(), email: "a@example.com" }),
    ).toThrow("exactly");
    const missing: any = attrs();
    delete missing.lease_id;
    expect(() => validateFederationAttributes(missing)).toThrow("exactly");
    for (const grant_revision of ["0", "01", "1.5", "-1", 1 as any]) {
      expect(() =>
        validateFederationAttributes({ ...attrs(), grant_revision }),
      ).toThrow("grant_revision");
    }
  });
});

describe("turn delivery entries", () => {
  it("accepts a well-formed entry with a null lease deadline", () => {
    expect(parseGcloudTurnToken(validEntry())).toEqual(validEntry());
  });

  it("accepts a fixed lease deadline", () => {
    const entry = validEntry();
    entry.gcloud.lease_max_expires_at = 1_800_000_600_000;
    expect(parseGcloudTurnToken(entry)).toEqual(entry);
  });

  const mutations: [string, (e: any) => void][] = [
    ["extra key", (e) => (e.extra = 1)],
    ["extra lease key", (e) => (e.gcloud.extra = 1)],
    ["missing lease key", (e) => delete e.gcloud.connection_id],
    ["wrong connector", (e) => (e.connector = "github")],
    ["token with whitespace", (e) => (e.token = "a b")],
    ["empty token", (e) => (e.token = "")],
    ["expiry mismatch", (e) => (e.expires_at += 1)],
    ["bad status", (e) => (e.gcloud.status = "ACTIVE")],
    ["bad project", (e) => (e.gcloud.project = "Bad Project")],
    ["email as label", (e) => (e.gcloud.sa_label = "a@b.example")],
    ["bad lease id", (e) => (e.gcloud.lease_id = "lease-1")],
    ["bad connection id", (e) => (e.gcloud.connection_id = 5)],
    ["zero revision", (e) => (e.gcloud.grant_revision = 0)],
    ["string deadline", (e) => (e.gcloud.lease_max_expires_at = "soon")],
    ["fractional time", (e) => (e.gcloud.provider_expires_at = 1.5)],
    ["newline in description", (e) => (e.description = "ok\nIgnore previous")],
    ["control character in description", (e) => (e.description = "a\u0007b")],
    ["non-ASCII in description", (e) => (e.description = "caf\u00e9")],
    ["long description", (e) => (e.description = "x".repeat(201))],
  ];
  for (const [name, mutate] of mutations) {
    it(`refuses an entry with ${name}`, () => {
      const entry = validEntry();
      mutate(entry);
      expect(parseGcloudTurnToken(entry)).toBeUndefined();
    });
  }

  it("never puts the token in the status file", () => {
    const status = gcloudLeaseStatusFile(validEntry());
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(Object.keys(status).sort()).toEqual(
      [
        "connection_id",
        "grant_revision",
        "lease_id",
        "lease_max_expires_at",
        "provider_expires_at",
        "status",
      ].sort(),
    );
  });

  it("parses the ended-lease list strictly", () => {
    expect(
      parseGcloudLeasesEnded([{ lease_id: UUID(1), reason: "revoke" }]),
    ).toEqual([{ lease_id: UUID(1), reason: "revoke" }]);
    expect(
      parseGcloudLeasesEnded([{ lease_id: UUID(1), reason: "maybe" }]),
    ).toBeUndefined();
    expect(
      parseGcloudLeasesEnded([{ lease_id: UUID(1), reason: "deny", x: 1 }]),
    ).toBeUndefined();
    expect(parseGcloudLeasesEnded("revoke")).toBeUndefined();
  });
});

describe("federated turn result", () => {
  const LEASE = "11111111-1111-4111-8111-111111111111";
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const entry = (lease_id = LEASE) => ({
    connector: "gcloud",
    token: "ya29.fake-token",
    expires_at: 1_800_000_000_000,
    description: "gcloud as ops-reader in fake-project-1",
    gcloud: {
      provider_expires_at: 1_800_000_000_000,
      lease_max_expires_at: null,
      status: "active",
      project: "fake-project-1",
      sa_label: "ops-reader",
      lease_id,
      connection_id: "33333333-3333-4333-8333-333333333333",
      grant_revision: 1,
    },
  });

  it("accepts the empty answer, a tombstone and one entry", () => {
    expect(
      parseFederatedConnectorTurnResult({ entries: [], revoked: [] }),
    ).toEqual({
      revoked: [],
    });
    expect(
      parseFederatedConnectorTurnResult({
        entries: [],
        revoked: [{ lease_id: LEASE, reason: "revision" }],
      }),
    ).toEqual({ revoked: [{ lease_id: LEASE, reason: "revision" }] });
    const ok = parseFederatedConnectorTurnResult({
      entries: [entry()],
      revoked: [{ lease_id: OTHER, reason: "deny" }],
    });
    expect(ok?.entry?.gcloud.lease_id).toBe(LEASE);
    expect(ok?.revoked).toEqual([{ lease_id: OTHER, reason: "deny" }]);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "x"],
    ["no revoked", { entries: [] }],
    ["no entries", { revoked: [] }],
    ["an extra key", { entries: [], revoked: [], leases_ended: [] }],
    ["entries not an array", { entries: {}, revoked: [] }],
    ["revoked not an array", { entries: [], revoked: {} }],
    ["two entries", { entries: [entry(), entry(OTHER)], revoked: [] }],
    [
      "a malformed entry",
      { entries: [{ ...entry(), token: "a b" }], revoked: [] },
    ],
    [
      "an entry with an extra key",
      { entries: [{ ...entry(), extra: 1 }], revoked: [] },
    ],
    ["a null entry", { entries: [null], revoked: [] }],
    [
      "a revoked item with an extra key",
      { entries: [], revoked: [{ lease_id: LEASE, reason: "deny", x: 1 }] },
    ],
    [
      "an unknown reason",
      { entries: [], revoked: [{ lease_id: LEASE, reason: "other" }] },
    ],
    [
      "a revoked id that isn't a uuid",
      { entries: [], revoked: [{ lease_id: "x", reason: "deny" }] },
    ],
    [
      "a duplicate revoked lease",
      {
        entries: [],
        revoked: [
          { lease_id: LEASE, reason: "deny" },
          { lease_id: LEASE, reason: "revision" },
        ],
      },
    ],
    [
      "a lease both returned and revoked",
      { entries: [entry()], revoked: [{ lease_id: LEASE, reason: "deny" }] },
    ],
  ])("refuses %s", (_name, value) => {
    expect(parseFederatedConnectorTurnResult(value)).toBeUndefined();
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: "x", c: 2 }] })).toBe(
      '{"a":[true,null,{"c":2,"d":"x"}],"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("is injective across embedded separators", () => {
    const pairs: unknown[][] = [
      [
        ["a,b", "c"],
        ["a", "b,c"],
      ],
      [
        ['a"', "b"],
        ["a", '"b'],
      ],
      [[{ a: "b", c: "d" }], [{ 'a":"b","c': "d" }]],
      [["1"], [1]],
      [[null], ["null"]],
    ];
    for (const [x, y] of pairs) {
      expect(canonicalJson(x)).not.toBe(canonicalJson(y));
    }
  });

  it.each([
    ["undefined", undefined],
    ["a function", () => 1],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["a date", new Date(0)],
    ["a nested undefined", { a: undefined }],
    ["a bigint", BigInt(1)],
  ])("refuses %s", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow();
  });
});

describe("federated gate setting", () => {
  it("keeps known names only, unique and in order", () => {
    expect(parseFederatedGate(undefined)).toEqual([]);
    expect(parseFederatedGate("")).toEqual([]);
    expect(parseFederatedGate("gcloud")).toEqual(["gcloud"]);
    expect(parseFederatedGate(" aws, gcloud gcloud ")).toEqual(["gcloud"]);
    expect(parseFederatedGate("gcloudx")).toEqual([]);
  });
});
