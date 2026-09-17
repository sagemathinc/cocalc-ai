import { generateKeyPairSync, sign } from "node:crypto";
import { DataEncoding, encode } from "@cocalc/conat/core/codec";
import { canonicalFundingTerms } from "./approvals";
import {
  verifyFundingRolloutManifest,
  fundingExposureAllocationDigest,
  getProductionFundingExposureAllocation,
} from "./production-rollout-manifest";
import {
  initFundingRolloutVerifiers,
  stopFundingRolloutVerifiers,
} from "./rollout-startup";
import { getLocalFundingRolloutCapabilities } from "./rollout";
import * as rollout from "./rollout";
import {
  FUNDING_ACCOUNT_WRITER_ROLES,
  FUNDING_RESOURCE_WRITER_ROLES,
} from "./production-rollout-contract";
import type { FundingRolloutManifest } from "./production-rollout-contract";
import {
  loadFundingExposureBudget,
  assertFundingExposureAvailable,
} from "./exposure";
import { FUNDING_AUTHORITY_TABLES } from "./account-writer-rollout";

const mockQuery = jest.fn();
const mockOpen = jest.fn();
const mockRegistry = jest.fn();
const mockConfig = jest.fn();
const mockRpc = jest.fn();
let mockExposure = "0";
let mockAllocationMatches = true;
let mockCatalog = [{ bay_id: "home" }];
let mockProtocol = 1;
jest.mock("node:fs/promises", () => ({ open: (...args) => mockOpen(...args) }));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: mockQuery,
    connect: async () => ({ query: mockQuery, release() {} }),
  }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
  getConfiguredClusterBayCatalog: () => mockCatalog,
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => "home",
  isMultiBayCluster: () => mockCatalog.length > 1,
}));
jest.mock("@cocalc/server/bay-registry", () => ({
  listClusterBayRegistry: (...args) => mockRegistry(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({ fastRpcRequest: mockRpc }),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({}),
}));
jest.mock("../config", () => ({
  getComputeVmConfig: (...args) => mockConfig(...args),
}));
jest.mock("../worker", () => ({
  get SPONSORED_RESOURCE_WRITER_PROTOCOL_VERSION() {
    return mockProtocol;
  },
}));
jest.mock("../resource-names", () => ({
  computeDeploymentNamespace: () => "abcdef0123456789",
}));

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const environment = { ...process.env };
let manifest: FundingRolloutManifest;
function signed(value = manifest) {
  return JSON.stringify({
    manifest: value,
    signature: sign(
      null,
      Buffer.from(canonicalFundingTerms(value)),
      keys.privateKey,
    ).toString("base64"),
  });
}
function fixture(): FundingRolloutManifest {
  return {
    kind: "cocalc-funding-rollout",
    version: 1,
    deployment_id: "deployment",
    rollout_id: "rollout",
    seed_bay_id: "home",
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    bays: [
      {
        bay_id: "home",
        namespace: "abcdef0123456789",
        database: {
          name: "smc",
          system_identifier: "123456",
          writer_roles: ["hub"],
          operator_roles: ["operator"],
          retired_roles: [],
        },
        writers: [
          {
            id: "hub-1",
            build_id: "build-1",
            protocol_version: 1,
            database_role: "hub",
            roles: [
              ...FUNDING_ACCOUNT_WRITER_ROLES,
              ...FUNDING_RESOURCE_WRITER_ROLES,
            ],
          },
        ],
        resource_credentials: [],
        retired_resource_credentials: [],
        credential_rollout: {
          epoch: "fresh-credentials",
          mode: "bootstrap",
          completed_at: new Date(Date.now() - 2000).toISOString(),
          evidence_id: "operator-census-1",
        },
      },
    ],
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  manifest = fixture();
  mockCatalog = [{ bay_id: "home" }];
  mockProtocol = 1;
  mockExposure = "0";
  mockAllocationMatches = true;
  delete process.env.COCALC_FUNDING_ISOLATED_QA;
  Object.assign(process.env, {
    COCALC_FUNDING_ROLLOUT_MANIFEST: "/operator/manifest",
    COCALC_FUNDING_ROLLOUT_PUBLIC_KEY: "/operator/key",
    COCALC_FUNDING_ROLLOUT_ID: "rollout",
    COCALC_COMPUTE_DEPLOYMENT_ID: "deployment",
    COCALC_FUNDING_WRITER_ID: "hub-1",
    COCALC_FUNDING_WRITER_BUILD_ID: "build-1",
  });
  mockConfig.mockResolvedValue({});
  mockRegistry.mockImplementation(async () => mockCatalog);
  mockRpc.mockImplementation(async (subject) => {
    const digest = verifyFundingRolloutManifest(signed(), publicKey).digest;
    const as_of = new Date().toISOString();
    const check = (name: string) => ({
      protocol_version: 1,
      enforced: true,
      evidence_id: `manifest:${digest}:${name}`,
      as_of,
      expires_at: manifest.expires_at,
    });
    return {
      raw: encode({
        encoding: DataEncoding.MsgPack,
        mesg: {
          bay_id: subject.split(".")[1],
          protocol_version: 1,
          as_of,
          checks: {
            "account-holds": check("account-holds"),
            "sponsored-resources": check("sponsored-resources"),
          },
        },
      }),
    };
  });
  mockOpen.mockImplementation(async (path) => {
    const bytes = Buffer.from(path === "/operator/key" ? publicKey : signed());
    return {
      stat: async () => ({
        isFile: () => true,
        size: bytes.length,
        mode: 0o600,
        uid: process.getuid!(),
      }),
      read: async (buffer, offset, length, position) => {
        // Exercise short reads, including multi-byte JSON boundaries.
        const bytesRead = Math.min(97, length, bytes.length - position);
        bytes.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
      close: jest.fn(),
    };
  });
  mockQuery.mockImplementation(async (sql) => {
    if (
      ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) ||
      sql.includes("pg_advisory_xact_lock") ||
      sql.startsWith("INSERT INTO compute_funding_exposure_policy")
    )
      return { rows: [] };
    if (sql.includes("allocation=$2::jsonb"))
      return { rows: [{ matches: mockAllocationMatches }] };
    if (sql.includes("FROM compute_funding_reservations"))
      return { rows: [{ amount: mockExposure }] };
    if (sql.includes("FROM server_settings"))
      return { rows: [{ value: "yes" }] };
    if (sql.includes("pg_control_system"))
      return {
        rows: [{ database: "smc", role: "hub", system_identifier: "123456" }],
      };
    if (sql.includes("WITH tables"))
      return {
        rows: [
          { role: "hub", superuser: false, bypass_rls: false },
          { role: "operator", superuser: true, bypass_rls: true },
        ],
      };
    if (sql.includes("pg_stat_activity")) return { rows: [] };
    throw Error("Unexpected verifier query");
  });
});
function threeBayAllocation() {
  for (const bay_id of ["payer-2", "resources"]) {
    manifest.bays.push({ ...manifest.bays[0], bay_id });
    mockCatalog.push({ bay_id });
  }
  manifest.exposure_allocation = {
    id: "static-allocation-1",
    site_ceiling_usd: "100",
    bay_quotas: [
      { bay_id: "home", amount_usd: "30" },
      { bay_id: "payer-2", amount_usd: "50" },
      { bay_id: "resources", amount_usd: "20" },
    ],
  };
  process.env.COCALC_FUNDING_EXPOSURE_ALLOCATION_SHA256 =
    fundingExposureAllocationDigest(manifest);
  process.env.COCALC_COURSE_VM_SITE_EXPOSURE_USD = "100";
}

it("connects signed three-bay startup evidence to actual exposure admission and its locked quota check", async () => {
  threeBayAllocation();
  initFundingRolloutVerifiers();
  const budget = await loadFundingExposureBudget("resources");
  expect(budget.limit_usd).toBe("30.0000000000");
  expect(budget.proof?.bay_ids).toEqual(["home", "payer-2", "resources"]);
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("compute_funding_exposure_policy"),
    expect.any(Array),
  );
  mockExposure = "29";
  await expect(
    assertFundingExposureAvailable({ query: mockQuery } as any, budget, "1"),
  ).resolves.toBeUndefined();
  await expect(
    assertFundingExposureAvailable({ query: mockQuery } as any, budget, "1.01"),
  ).rejects.toThrow("exposure quota");
});
it("requires rollout admission for sponsored reservations in isolated one-bay mode", async () => {
  delete process.env.COCALC_FUNDING_ROLLOUT_MANIFEST;
  const proof = { expires_at: Date.now() + 30_000, bay_ids: ["home"] };
  const admission = jest
    .spyOn(rollout, "assertSponsorshipAdmission")
    .mockResolvedValue(proof);

  await expect(loadFundingExposureBudget("home")).resolves.toEqual({
    limit_usd: "100.0000000000",
    proof: undefined,
  });
  await expect(
    loadFundingExposureBudget("home", {
      require_sponsorship_admission: true,
    }),
  ).resolves.toEqual({ limit_usd: "100.0000000000", proof });
  expect(admission).toHaveBeenCalledTimes(1);
});
it.each([
  "over quota",
  "changed durable quota",
  "missing bay",
  "missing allocation pin",
  "wrong owning bay",
])(
  "rejects %s through the actual signed exposure admission path",
  async (fault) => {
    threeBayAllocation();
    if (fault === "over quota") mockExposure = "31";
    if (fault === "changed durable quota") mockAllocationMatches = false;
    if (fault === "missing bay")
      mockRpc.mockRejectedValue(Error("missing resource bay"));
    if (fault === "missing allocation pin")
      delete process.env.COCALC_FUNDING_EXPOSURE_ALLOCATION_SHA256;
    initFundingRolloutVerifiers();
    await expect(
      loadFundingExposureBudget(
        fault === "wrong owning bay" ? "outsider" : "resources",
      ),
    ).rejects.toThrow();
  },
);
afterEach(() => {
  jest.restoreAllMocks();
  stopFundingRolloutVerifiers();
  for (const key of Object.keys(process.env))
    if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
});
it.each(["manifest", "admission proof"])(
  "rechecks %s freshness after waiting for the exposure lock",
  async (kind) => {
    threeBayAllocation();
    initFundingRolloutVerifiers();
    const budget = await loadFundingExposureBudget("resources");
    const query = mockQuery.getMockImplementation()!;
    const before = Date.now();
    let now = before;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    mockQuery.mockImplementation(async (sql, ...args) => {
      if (sql.includes("pg_advisory_xact_lock"))
        now = before + (kind === "manifest" ? 70_000 : 31_000);
      return query(sql, ...args);
    });
    await expect(
      assertFundingExposureAvailable({ query: mockQuery } as any, budget, "1"),
    ).rejects.toThrow(
      kind === "manifest" ? "attestation expired" : "admission changed",
    );
  },
);

it("verifies real signatures independent of JSON key order", () => {
  const document = JSON.parse(signed());
  document.manifest = Object.fromEntries(
    Object.entries(document.manifest).reverse(),
  );
  expect(
    verifyFundingRolloutManifest(JSON.stringify(document), publicKey).manifest,
  ).toEqual(manifest);
  document.manifest.rollout_id = "tampered";
  expect(() =>
    verifyFundingRolloutManifest(JSON.stringify(document), publicKey),
  ).toThrow("signature");
});
it.each([
  "missing role",
  "old protocol",
  "unknown field",
  "expired",
  "long validity",
  "duplicate bay",
  "unretired rotation",
])("rejects signed but unsafe %s", (fault) => {
  if (fault === "missing role") manifest.bays[0].writers[0].roles.pop();
  if (fault === "old protocol")
    manifest.bays[0].writers[0].protocol_version = 0;
  if (fault === "unknown field") (manifest as any).trust_me = true;
  if (fault === "expired")
    manifest.expires_at = new Date(Date.now() - 1).toISOString();
  if (fault === "long validity")
    manifest.expires_at = new Date(Date.now() + 3600000).toISOString();
  if (fault === "duplicate bay") manifest.bays.push(manifest.bays[0]);
  if (fault === "unretired rotation")
    Object.assign(manifest.bays[0].credential_rollout, {
      mode: "rotation",
      previous_epoch: "old",
    });
  expect(() => verifyFundingRolloutManifest(signed(), publicKey)).toThrow();
});
it("connects actual production startup, signed file reader and observed database/resource checks", async () => {
  initFundingRolloutVerifiers();
  const result = await getLocalFundingRolloutCapabilities();
  const digest = verifyFundingRolloutManifest(signed(), publicKey).digest;
  for (const check of ["account-holds", "sponsored-resources"] as const)
    expect(result.checks[check]).toMatchObject({
      enforced: true,
      evidence_id: `manifest:${digest}:${check}`,
    });
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("pg_control_system()"),
  );
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("WITH tables"),
    [FUNDING_AUTHORITY_TABLES],
  );
});
it.each([
  "unknown writer",
  "retired session",
  "wrong database",
  "wrong build",
  "wrong resource key",
  "old resource worker",
  "missing bay",
])("connected startup fails closed for %s", async (fault) => {
  const goodQuery = mockQuery.getMockImplementation()!;
  if (fault === "unknown writer")
    mockQuery.mockImplementation(async (sql, ...args) =>
      sql.includes("WITH tables")
        ? {
            rows: [{ role: "old-worker", superuser: false, bypass_rls: false }],
          }
        : goodQuery(sql, ...args),
    );
  if (fault === "retired session") {
    manifest.bays[0].database.retired_roles.push({
      id: "old-worker",
      revoked_at: manifest.bays[0].credential_rollout.completed_at,
      evidence_id: "disabled",
    });
    mockQuery.mockImplementation(async (sql, ...args) =>
      sql.includes("pg_stat_activity")
        ? { rows: [{ usename: "old-worker" }] }
        : goodQuery(sql, ...args),
    );
  }
  if (fault === "wrong database")
    manifest.bays[0].database.system_identifier = "789";
  if (fault === "wrong build")
    process.env.COCALC_FUNDING_WRITER_BUILD_ID = "old";
  if (fault === "wrong resource key")
    mockConfig.mockResolvedValue({
      gcp_project_id: "project",
      gcp_service_account_json: JSON.stringify({
        client_email: "worker@example.test",
        private_key_id: "unattested",
      }),
    });
  if (fault === "old resource worker") mockProtocol = 0;
  if (fault === "missing bay") mockCatalog.push({ bay_id: "missing" });
  initFundingRolloutVerifiers();
  expect(
    (await getLocalFundingRolloutCapabilities()).checks["sponsored-resources"],
  ).toBeNull();
});
it("provides a pinned three-bay quota and rejects over-allocation, omissions and changed pins", async () => {
  for (const bay_id of ["payer-2", "resources"]) {
    manifest.bays.push({ ...manifest.bays[0], bay_id });
    mockCatalog.push({ bay_id });
  }
  expect(() => verifyFundingRolloutManifest(signed(), publicKey)).toThrow(
    "exposure allocation",
  );
  manifest.exposure_allocation = {
    id: "static-allocation-1",
    site_ceiling_usd: "100",
    bay_quotas: [
      { bay_id: "home", amount_usd: "30" },
      { bay_id: "payer-2", amount_usd: "50" },
      { bay_id: "resources", amount_usd: "20" },
    ],
  };
  process.env.COCALC_FUNDING_EXPOSURE_ALLOCATION_SHA256 =
    fundingExposureAllocationDigest(manifest);
  await expect(getProductionFundingExposureAllocation()).resolves.toMatchObject(
    { bay_id: "home", quota_usd: "30", site_ceiling_usd: "100" },
  );
  manifest.exposure_allocation.bay_quotas[0].amount_usd = "31";
  expect(() => verifyFundingRolloutManifest(signed(), publicKey)).toThrow(
    "site ceiling",
  );
  manifest.exposure_allocation.bay_quotas[0].amount_usd = "29";
  await expect(getProductionFundingExposureAllocation()).rejects.toThrow(
    "pinned deployment quota",
  );
  manifest.exposure_allocation.bay_quotas.pop();
  expect(() => verifyFundingRolloutManifest(signed(), publicKey)).toThrow(
    "exactly",
  );
});
