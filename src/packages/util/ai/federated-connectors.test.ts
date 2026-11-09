/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  federationIssuer,
  gcloudLeaseStatusFile,
  isFederatedCliConnector,
  isGcpProjectId,
  isGcpServiceAccount,
  isSaLabel,
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
