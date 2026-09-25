import { DataEncoding, encode, decode } from "@cocalc/conat/core/codec";
import type {
  FundingRolloutCapabilities,
  FundingRolloutEvidence,
} from "@cocalc/util/compute-funding-rollout";
import {
  assertSponsorshipAdmission,
  assertSponsorshipAdmissionInTransaction,
  getLocalFundingRolloutCapabilities,
  getSponsorshipAvailability,
  registerFundingRolloutVerifier,
} from "./rollout";

const mockQuery = jest.fn();
const mockRpc = jest.fn();
const mockRegistry = jest.fn();
let mockCatalog = [{ bay_id: "home" }];
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
  getConfiguredClusterBayCatalog: () => mockCatalog,
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: () => mockCatalog.length > 1,
}));
jest.mock("@cocalc/server/bay-registry", () => ({
  listClusterBayRegistry: (...args) => mockRegistry(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({ fastRpcRequest: mockRpc }),
}));

const removers: (() => void)[] = [];
const evidence = (): FundingRolloutEvidence => ({
  protocol_version: 1,
  enforced: true,
  evidence_id: "test-credential-fence",
  as_of: new Date().toISOString(),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
});
const capabilities = (bay_id = "remote"): FundingRolloutCapabilities => ({
  bay_id,
  protocol_version: 1,
  as_of: new Date().toISOString(),
  checks: { "account-holds": evidence(), "sponsored-resources": evidence() },
});
function register() {
  for (const check of ["account-holds", "sponsored-resources"] as const)
    removers.push(
      registerFundingRolloutVerifier(check, async () => evidence()),
    );
}
function remote(response = capabilities()) {
  mockCatalog.push({ bay_id: "remote" });
  mockRegistry.mockResolvedValue(mockCatalog);
  mockRpc.mockResolvedValue({
    raw: encode({ encoding: DataEncoding.MsgPack, mesg: response }),
  });
}
beforeEach(() => {
  jest.resetAllMocks();
  mockCatalog = [{ bay_id: "home" }];
  mockQuery.mockResolvedValue({ rows: [{ value: "yes" }] });
});
afterEach(() => {
  removers.splice(0).forEach((remove) => remove());
});

it.each([
  { rows: [] },
  { rows: [{ value: "no" }] },
  { rows: [{ value: "false" }] },
])(
  "defaults off and never requests writer evidence when disabled",
  async ({ rows }) => {
    mockQuery.mockResolvedValue({ rows });
    expect(await getSponsorshipAvailability()).toMatchObject({
      enabled: false,
      available: false,
    });
    await expect(assertSponsorshipAdmission()).rejects.toThrow("disabled");
    expect(mockRpc).not.toHaveBeenCalled();
  },
);
it("does not mistake enabled flags or this hub's version for all-writer evidence", async () => {
  expect((await getLocalFundingRolloutCapabilities()).checks).toEqual({
    "account-holds": null,
    "sponsored-resources": null,
  });
  await expect(assertSponsorshipAdmission()).rejects.toThrow(
    "capability verification failed",
  );
  removers.push(
    registerFundingRolloutVerifier("account-holds", async () => evidence()),
  );
  expect(await getSponsorshipAvailability()).toMatchObject({
    enabled: true,
    available: false,
  });
});
it("uses the real registered interbay client and verifies every bay before issuing a short-lived proof", async () => {
  register();
  remote();
  const proof = await assertSponsorshipAdmission();
  expect(proof.bay_ids).toEqual(["home", "remote"]);
  expect(proof.expires_at).toBeLessThanOrEqual(Date.now() + 30_000);
  expect(mockRpc).toHaveBeenCalledWith(
    "bay.remote.rpc.account-local.compute-funding",
    { raw: expect.any(Uint8Array) },
    { timeout: 5000 },
  );
  expect(
    decode({
      encoding: DataEncoding.MsgPack,
      data: mockRpc.mock.calls[0][1].raw,
    }),
  ).toMatchObject({ name: "computeFundingGetRolloutCapabilities", args: [{}] });
  await expect(
    assertSponsorshipAdmissionInTransaction({ query: mockQuery } as any, proof),
  ).resolves.toBeUndefined();
  expect(mockQuery.mock.calls.at(-1)[0]).toContain("FOR SHARE");
  mockQuery.mockResolvedValue({ rows: [{ value: "no" }] });
  await expect(
    assertSponsorshipAdmissionInTransaction({ query: mockQuery } as any, proof),
  ).rejects.toThrow("admission changed");
});
it.each([
  "missing",
  "wrong bay",
  "old version",
  "missing writer",
  "unenforced",
  "stale",
  "expired",
  "registry",
])(
  "fails closed on %s without treating a partial fanout as ready",
  async (fault) => {
    register();
    const response = capabilities();
    if (fault === "wrong bay") response.bay_id = "other";
    if (fault === "old version") response.protocol_version = 0;
    if (fault === "missing writer") response.checks["account-holds"] = null;
    if (fault === "unenforced")
      response.checks["sponsored-resources"]!.enforced = false;
    if (fault === "stale")
      response.checks["account-holds"]!.as_of = new Date(
        Date.now() - 31_000,
      ).toISOString();
    if (fault === "expired")
      response.checks["account-holds"]!.expires_at = new Date(
        Date.now() - 1,
      ).toISOString();
    remote(response);
    if (fault === "missing") mockRpc.mockRejectedValue(Error("bay offline"));
    if (fault === "registry") mockRegistry.mockResolvedValue([]);
    await expect(assertSponsorshipAdmission()).rejects.toThrow(
      "capability verification failed",
    );
    expect((await getSponsorshipAvailability()).available).toBe(false);
  },
);
it("rejects structurally forged admission proofs and bounds configured bay fanout", async () => {
  await expect(
    assertSponsorshipAdmissionInTransaction({ query: mockQuery } as any, {
      expires_at: Date.now() + 60_000,
      bay_ids: ["home"],
    }),
  ).rejects.toThrow("admission changed");
  mockCatalog = [
    { bay_id: "home" },
    ...Array.from({ length: 32 }, (_, i) => ({ bay_id: `bay-${i}` })),
  ];
  mockRegistry.mockResolvedValue(mockCatalog);
  await expect(assertSponsorshipAdmission()).rejects.toThrow(
    "capability verification failed",
  );
  expect(mockRpc).not.toHaveBeenCalled();
});
it.each(["same", "different", "mixed"])(
  "checks %s manifest evidence through registered interbay fanout",
  async (mode) => {
    for (const check of ["account-holds", "sponsored-resources"] as const)
      removers.push(
        registerFundingRolloutVerifier(check, async () => ({
          ...evidence(),
          evidence_id: `manifest:${"a".repeat(64)}:${check}`,
        })),
      );
    const response = capabilities();
    if (mode !== "mixed") {
      for (const check of ["account-holds", "sponsored-resources"] as const)
        response.checks[check]!.evidence_id =
          `manifest:${(mode === "same" ? "a" : "b").repeat(64)}:${check}`;
    }
    remote(response);
    if (mode === "same")
      await expect(assertSponsorshipAdmission()).resolves.toMatchObject({
        bay_ids: ["home", "remote"],
      });
    else
      await expect(assertSponsorshipAdmission()).rejects.toThrow(
        "capability verification failed",
      );
  },
);
