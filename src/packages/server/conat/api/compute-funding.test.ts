import type { CourseFundingDraft } from "@cocalc/conat/hub/api/compute-funding";
import { initHubApi, transformArgs } from "@cocalc/conat/hub/api";

const mockQuery = jest.fn();
const mockTransaction = jest.fn();
const mockPolicy = jest.fn();
const mockHome = jest.fn();
const mockProjectBay = jest.fn();
const mockLocalAccess = jest.fn();
const mockRemoteReference = jest.fn();
const mockProjectReferenceClient = jest.fn(() => ({
  get: mockRemoteReference,
}));
const mockAccounts = jest.fn();
const mockPropose = jest.fn();
const mockStatus = jest.fn();
const mockPreviewChange = jest.fn();
const mockProposeChange = jest.fn();
const mockHasPoolChangeApproval = jest.fn();
const mockGetPoolChangeOperation = jest.fn();
const mockApplyPoolChange = jest.fn();
const mockPrepareRecipients = jest.fn();
const mockSourcesOnBay = jest.fn();
const mockRegistry = jest.fn();
const mockSponsorship = jest.fn();
const mockSponsorshipAvailability = jest.fn();
const mockRemote = {
  computeFundingGetOwnedPools: jest.fn(),
  computeFundingGetCourseSummary: jest.fn(),
  computeFundingListSources: jest.fn(),
  computeFundingPreviewAllocation: jest.fn(),
  computeFundingProposeAllocation: jest.fn(),
  computeFundingGetAllocationStatus: jest.fn(),
  computeFundingListSourcesOnBay: jest.fn(),
  computeFundingPreviewPoolChange: jest.fn(),
  computeFundingProposePoolChange: jest.fn(),
};
const mockRemoteClient = jest.fn(() => mockRemote);
let mockMultiBay = false;
let mockBillingAuthority = false;
let mockCatalog = [{ bay_id: "home" }];

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
  getConfiguredClusterBayCatalog: () => mockCatalog,
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args) => mockHome(...args),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: () => mockMultiBay,
}));
jest.mock("@cocalc/server/purchases/billing-authority/config", () => ({
  isBillingAuthorityEnabled: () => mockBillingAuthority,
}));
jest.mock("@cocalc/server/bay-registry", () => ({
  listClusterBayRegistry: (...args) => mockRegistry(...args),
}));
jest.mock("@cocalc/server/compute/funding/sources", () => ({
  listCourseFundingSourcesOnBay: (...args) => mockSourcesOnBay(...args),
}));
jest.mock("@cocalc/server/compute/funding/rollout", () => ({
  assertSponsorshipAdmission: (...args) => mockSponsorship(...args),
  getSponsorshipAvailability: (...args) => mockSponsorshipAvailability(...args),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: (...args) => mockRemoteClient(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => ({ projectReference: mockProjectReferenceClient }),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args) => mockProjectBay(...args),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountsByIds: (...args) => mockAccounts(...args),
}));
jest.mock("@cocalc/server/conat/project-local-access", () => ({
  assertLocalProjectCollaborator: (...args) => mockLocalAccess(...args),
}));
jest.mock("@cocalc/server/compute/funding/backing", () => ({
  withFundingAccountTransaction: (...args) => mockTransaction(...args),
}));
jest.mock("@cocalc/server/compute/funding/policy", () => ({
  getComputeFundingPolicyInTransaction: (...args) => mockPolicy(...args),
}));
jest.mock("@cocalc/server/compute/funding/approvals", () => ({
  proposeCourseFundingAllocation: (...args) => mockPropose(...args),
  getCourseFundingAllocationStatus: (...args) => mockStatus(...args),
  proposeCourseFundingPoolChange: (...args) => mockProposeChange(...args),
  hasCourseFundingPoolChangeApproval: (...args) =>
    mockHasPoolChangeApproval(...args),
}));
jest.mock("@cocalc/server/compute/funding/pool-changes", () => ({
  ...jest.requireActual("@cocalc/server/compute/funding/pool-changes"),
  previewCourseFundingPoolChangeInTransaction: (...args) =>
    mockPreviewChange(...args),
  getCourseFundingPoolChangeOperation: (...args) =>
    mockGetPoolChangeOperation(...args),
  changeCourseFundingPoolWithinEnvelopeInTransaction: (...args) =>
    mockApplyPoolChange(...args),
}));
jest.mock("@cocalc/server/compute/funding/approval-recipients", () => ({
  prepareFundingRecipientAccounts: (...args) => mockPrepareRecipients(...args),
}));

import * as handlers from "./compute-funding";

const payer = "10000000-0000-4000-8000-000000000001";
const beneficiary = "10000000-0000-4000-8000-000000000002";
const project = "10000000-0000-4000-8000-000000000003";
const instance = "10000000-0000-4000-8000-000000000004";
const operation = "10000000-0000-4000-8000-000000000005";
const intent = "10000000-0000-4000-8000-000000000006";
const now = new Date("2026-09-12T10:00:00.000Z");
const money = {
  authorized_usd: "10",
  spent_usd: "1",
  reserved_usd: "2",
  released_usd: "0",
};
const terms: CourseFundingDraft = {
  course_project_id: project,
  course_instance_id: instance,
  currency: "USD",
  lane: "prepaid",
  amount_usd: "10.0000000000",
  starts_at: "2026-09-12T00:00:00.000Z",
  ends_at: "2026-10-12T00:00:00.000Z",
  allow_overcommit: false,
  recipients: [
    { beneficiary_account_id: beneficiary, amount_usd: "10.0000000000" },
  ],
};
const change = {
  course_project_id: project,
  course_instance_id: instance,
  pool_id: intent,
  expected_version: 1,
  action: "close" as const,
};

// Exercise the registered client namespace and principal transforms, not an
// unregistered test-only API. Financial approval itself belongs to its worker.
function client(account_id = payer) {
  return initHubApi(async ({ name, args }) => {
    const transformed = await transformArgs({ name, args, account_id });
    const method = name.split(".")[1] as keyof typeof handlers;
    return await handlers[method](transformed[0]);
  }).computeFunding;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockMultiBay = false;
  mockBillingAuthority = false;
  mockCatalog = [{ bay_id: "home" }];
  mockHome.mockResolvedValue({ home_bay_id: "home" });
  mockRegistry.mockResolvedValue([{ bay_id: "home" }, { bay_id: "remote" }]);
  mockSourcesOnBay.mockResolvedValue({
    as_of: now.toISOString(),
    sources: [],
    payer_home_bay_ids: [],
  });
  mockRemote.computeFundingListSourcesOnBay.mockResolvedValue({
    as_of: now.toISOString(),
    sources: [],
    payer_home_bay_ids: [],
  });
  mockProjectBay.mockResolvedValue({ bay_id: "home", epoch: 0 });
  mockRemoteClient.mockReturnValue(mockRemote);
  mockProjectReferenceClient.mockReturnValue({ get: mockRemoteReference });
  mockTransaction.mockImplementation(
    async (_payer, fn) => await fn({ query: mockQuery }),
  );
  mockQuery.mockResolvedValue({ rows: [{ as_of: now }] });
  mockPolicy.mockResolvedValue({ available_backing_usd: "8.75" });
  mockPreviewChange.mockResolvedValue({
    pool: { grants: [] },
    requires_course_access: false,
    requires_financial_approval: false,
  });
  mockHasPoolChangeApproval.mockResolvedValue(false);
  mockGetPoolChangeOperation.mockResolvedValue(undefined);
  mockApplyPoolChange.mockResolvedValue({
    pool_id: intent,
    completed_at: now.toISOString(),
  });
  mockPrepareRecipients.mockResolvedValue(async () => ({
    [payer]: "home",
    [beneficiary]: "home",
  }));
  mockAccounts.mockResolvedValue([
    {
      account_id: beneficiary,
      display_name: "Verified Student",
      email_address: "private@example.com",
    },
  ]);
  mockPropose.mockResolvedValue({
    id: intent,
    status: "pending",
    expires_at: terms.ends_at,
    approval_url: "/funding/intent",
  });
});

describe("compute funding principal and routing boundaries", () => {
  it("registers server implementations for exactly the advertised methods", () => {
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(client()).sort());
  });

  it("binds proposal payer to the principal and drops frontend financial authority fields", async () => {
    await client().proposeAllocation({
      account_id: beneficiary,
      payer_account_id: beneficiary,
      operation_id: operation,
      terms: {
        ...terms,
        payer_account_id: beneficiary,
        capacity_usd: "1000000",
        recommended_templates: [
          { id: "nonbinding-metadata", label: "GPU lab" },
        ],
      },
    } as any);
    expect(mockPropose).toHaveBeenCalledWith({
      payer_account_id: payer,
      operation_id: operation,
      terms,
    });
    expect(mockLocalAccess).toHaveBeenCalledWith({
      account_id: payer,
      project_id: project,
    });
  });

  it("routes every method to the account home without local reads or approval", async () => {
    mockHome.mockResolvedValue({ home_bay_id: "remote-payer-home" });
    await client().getCourseSummary({
      course_project_id: project,
      course_instance_id: instance,
    });
    await client().getOwnedPools();
    await client().listSources();
    await client().previewAllocation({ terms });
    await client().proposeAllocation({ operation_id: operation, terms });
    await client().getAllocationStatus({ intent_id: intent });
    await client().previewPoolChange({ terms: change });
    await client().proposePoolChange({
      operation_id: operation,
      terms: change,
    });
    expect(mockRemoteClient).toHaveBeenCalledWith({
      client: {},
      dest_bay: "remote-payer-home",
    });
    expect(mockRemote.computeFundingGetCourseSummary).toHaveBeenCalledWith({
      account_id: payer,
      course_project_id: project,
      course_instance_id: instance,
    });
    expect(mockRemote.computeFundingGetOwnedPools).toHaveBeenCalledWith({
      account_id: payer,
    });
    expect(mockRemote.computeFundingListSources).toHaveBeenCalledWith({
      account_id: payer,
    });
    expect(mockRemote.computeFundingPreviewAllocation).toHaveBeenCalledWith({
      account_id: payer,
      terms,
    });
    expect(mockRemote.computeFundingProposeAllocation).toHaveBeenCalledWith({
      account_id: payer,
      operation_id: operation,
      terms,
    });
    expect(mockRemote.computeFundingGetAllocationStatus).toHaveBeenCalledWith({
      account_id: payer,
      intent_id: intent,
    });
    expect(mockRemote.computeFundingPreviewPoolChange).toHaveBeenCalledWith({
      account_id: payer,
      terms: change,
    });
    expect(mockRemote.computeFundingProposePoolChange).toHaveBeenCalledWith({
      account_id: payer,
      operation_id: operation,
      terms: change,
    });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockProjectBay).not.toHaveBeenCalled();
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it("does not fall back to local state when the payer home is unavailable", async () => {
    mockHome.mockResolvedValue({ home_bay_id: "remote" });
    mockRemote.computeFundingPreviewAllocation.mockRejectedValue(
      Error("bay offline"),
    );
    await expect(client().previewAllocation({ terms })).rejects.toThrow(
      "bay offline",
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("cannot override the authenticated owner or fall back when owned-pool routing fails", async () => {
    mockHome.mockResolvedValue({ home_bay_id: "remote" });
    mockRemote.computeFundingGetOwnedPools.mockRejectedValue(
      Error("payer home offline"),
    );
    await expect(
      (client().getOwnedPools as any)({
        account_id: beneficiary,
        payer_account_id: beneficiary,
      }),
    ).rejects.toThrow("payer home offline");
    expect(mockRemote.computeFundingGetOwnedPools).toHaveBeenCalledWith({
      account_id: payer,
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("blocks new allocation APIs when sponsorship is disabled without blocking status or cleanup", async () => {
    mockSponsorship.mockRejectedValue(
      Error("New course sponsorship is disabled."),
    );
    await expect(client().previewAllocation({ terms })).rejects.toThrow(
      "disabled",
    );
    await expect(
      client().proposeAllocation({ operation_id: operation, terms }),
    ).rejects.toThrow("disabled");
    expect(mockPropose).not.toHaveBeenCalled();
    await client().getAllocationStatus({ intent_id: intent });
    await client().previewPoolChange({ terms: change });
    await client().proposePoolChange({
      operation_id: operation,
      terms: change,
    });
    expect(mockApplyPoolChange).toHaveBeenCalled();
  });

  it("checks course collaboration at its owning bay before any backing read", async () => {
    mockProjectBay.mockResolvedValue({ bay_id: "course-owner", epoch: 2 });
    mockRemoteReference.mockResolvedValue({
      project_id: project,
      owning_bay_id: "course-owner",
      users: { [payer]: { group: "collaborator" } },
    });
    const result = await client().previewAllocation({ terms });
    expect(result.available_backing_usd).toBe("8.75");
    expect(mockProjectReferenceClient).toHaveBeenCalledWith("course-owner");
    expect(mockRemoteReference).toHaveBeenCalledWith({
      account_id: payer,
      project_id: project,
    });
    expect(mockLocalAccess).not.toHaveBeenCalled();
    expect(mockPolicy).toHaveBeenCalledWith(
      { query: mockQuery },
      { payer_account_id: payer, lane: "prepaid" },
    );
  });

  it.each(["viewer", undefined])(
    "rejects owning-bay permission %s without consulting stale local permission",
    async (group) => {
      mockProjectBay.mockResolvedValue({ bay_id: "course-owner" });
      mockRemoteReference.mockResolvedValue({
        project_id: project,
        owning_bay_id: "course-owner",
        users: { [payer]: { group } },
      });
      await expect(client().previewAllocation({ terms })).rejects.toThrow(
        "collaborator access required",
      );
      await expect(
        client().proposeAllocation({ operation_id: operation, terms }),
      ).rejects.toThrow("collaborator access required");
      expect(mockLocalAccess).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockPropose).not.toHaveBeenCalled();
    },
  );

  it("fails closed if the owning bay is unreachable", async () => {
    mockProjectBay.mockResolvedValue({ bay_id: "course-owner" });
    mockRemoteReference.mockRejectedValue(Error("owner unavailable"));
    await expect(client().previewAllocation({ terms })).rejects.toThrow(
      "owner unavailable",
    );
    expect(mockPolicy).not.toHaveBeenCalled();
  });

  it("passes only the authenticated payer and intent to status lookup", async () => {
    await client().getAllocationStatus({
      intent_id: intent,
      payer_account_id: beneficiary,
      account_id: beneficiary,
    } as any);
    expect(mockStatus).toHaveBeenCalledWith({
      payer_account_id: payer,
      intent_id: intent,
    });
  });

  it("rejects unsigned direct calls before routing", async () => {
    await expect(handlers.listSources()).rejects.toThrow("signed in");
    await expect(handlers.previewAllocation({ terms })).rejects.toThrow(
      "signed in",
    );
    await expect(
      handlers.proposeAllocation({ operation_id: operation, terms }),
    ).rejects.toThrow("signed in");
    await expect(
      handlers.getAllocationStatus({ intent_id: intent }),
    ).rejects.toThrow("signed in");
    await expect(
      handlers.getCourseSummary({
        course_project_id: project,
        course_instance_id: instance,
      }),
    ).rejects.toThrow("signed in");
    expect(mockHome).not.toHaveBeenCalled();
  });
});

describe("read-only funding projections", () => {
  it("returns normalized terms and actual locked backing without exposing private recipient emails", async () => {
    const result = await client().previewAllocation({
      terms: { ...terms, starts_at: "2026-09-11T20:00:00-04:00" },
    });
    expect(result).toEqual({
      terms,
      available_backing_usd: "8.75",
      as_of: now.toISOString(),
      recipients: [
        {
          beneficiary_account_id: beneficiary,
          display_name: "Verified Student",
        },
      ],
    });
    expect(mockTransaction).toHaveBeenCalledWith(payer, expect.any(Function));
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it("rejects nonexistent recipients before reading backing", async () => {
    mockAccounts.mockResolvedValue([]);
    await expect(client().previewAllocation({ terms })).rejects.toThrow(
      "recipient account not found",
    );
    expect(mockPolicy).not.toHaveBeenCalled();
  });

  it("scopes pool/grant reads to the payer and both course IDs and omits mutable internals", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "pool",
            state: "active",
            lane: "prepaid",
            ...money,
            starts_at: now,
            ends_at: new Date(terms.ends_at),
            hold_id: "private-hold",
            request_hash: "private-hash",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "grant",
            pool_id: "pool",
            beneficiary_account_id: beneficiary,
            state: "active",
            ...money,
            version: 99,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ as_of: now }] });
    const result = await client().getCourseSummary({
      course_project_id: project,
      course_instance_id: instance,
    });
    for (const [sql, params] of mockQuery.mock.calls.slice(0, 2)) {
      expect(sql).toMatch(/payer_account_id=\$1/);
      expect(sql).toMatch(/course_project_id=\$2/);
      expect(sql).toMatch(/course_instance_id=\$3/);
      expect(params).toEqual([payer, project, instance]);
    }
    expect(result).toEqual({
      as_of: now.toISOString(),
      sponsorship: undefined,
      pools: [
        {
          id: "pool",
          state: "active",
          lane: "prepaid",
          ...money,
          approval_limit_usd: "10.0000000000",
          approval_starts_at: now.toISOString(),
          approval_ends_at: terms.ends_at,
          starts_at: now.toISOString(),
          ends_at: terms.ends_at,
          grants: [
            {
              id: "grant",
              beneficiary_account_id: beneficiary,
              state: "active",
              version: 99,
              ...money,
            },
          ],
        },
      ],
    });
    expect(result.pools[0].grants[0]).not.toHaveProperty("running_vms");
    expect(result.pools[0].grants[0]).not.toHaveProperty("hourly_usd");
  });

  it("scopes standalone source discovery to the authenticated beneficiary", async () => {
    mockQuery.mockResolvedValue({ rows: [{ as_of: now, sources: [] }] });
    expect(await client(beneficiary).listSources()).toEqual({
      as_of: now.toISOString(),
      sources: [],
    });
    expect(mockSourcesOnBay).toHaveBeenCalledWith({
      beneficiary_account_id: beneficiary,
      beneficiary_home_bay_id: "home",
    });
    expect(mockRegistry).not.toHaveBeenCalled();
  });

  it("discovers seed-central funding without home routing or bay fanout", async () => {
    mockBillingAuthority = true;
    mockMultiBay = true;
    mockHome.mockResolvedValue({ home_bay_id: "remote-home" });

    await expect(client(beneficiary).listSources()).resolves.toEqual({
      as_of: now.toISOString(),
      sources: [],
    });

    expect(mockSourcesOnBay).toHaveBeenCalledWith({
      beneficiary_account_id: beneficiary,
      beneficiary_home_bay_id: "remote-home",
    });
    expect(mockRemote.computeFundingListSources).not.toHaveBeenCalled();
    expect(mockRemote.computeFundingListSourcesOnBay).not.toHaveBeenCalled();
    expect(mockRegistry).not.toHaveBeenCalled();
  });

  it("preserves historical discovery across home routing and all bay fanout", async () => {
    mockHome.mockResolvedValueOnce({ home_bay_id: "remote-home" });
    await client(beneficiary).listSources({ include_inactive: true });
    expect(mockRemote.computeFundingListSources).toHaveBeenCalledWith({
      account_id: beneficiary,
      include_inactive: true,
    });
    mockCatalog.push({ bay_id: "remote" });
    await client(beneficiary).listSources({ include_inactive: true });
    const request = {
      beneficiary_account_id: beneficiary,
      beneficiary_home_bay_id: "home",
      include_inactive: true,
    };
    expect(mockSourcesOnBay).toHaveBeenCalledWith(request);
    expect(mockRemote.computeFundingListSourcesOnBay).toHaveBeenCalledWith(
      request,
    );
    mockRemote.computeFundingListSourcesOnBay.mockRejectedValue(
      Error("missing historical bay"),
    );
    await expect(
      client(beneficiary).listSources({ include_inactive: true }),
    ).rejects.toThrow("missing historical bay");
  });

  it("previews and proposes cleanup as the payer even when the course was deleted", async () => {
    mockProjectBay.mockResolvedValue(undefined);
    await client().previewPoolChange({ terms: change });
    await client().proposePoolChange({
      operation_id: operation,
      terms: change,
      account_id: beneficiary,
      payer_account_id: beneficiary,
    } as any);
    expect(mockPreviewChange).toHaveBeenCalledWith(
      { query: mockQuery },
      { payer_account_id: payer, terms: change },
    );
    expect(mockApplyPoolChange).toHaveBeenCalledWith(
      { query: mockQuery },
      expect.objectContaining({
        payer_account_id: payer,
        operation_id: operation,
        terms: change,
      }),
    );
    expect(mockProjectBay).not.toHaveBeenCalled();
  });

  it("blocks expanded pool previews when the owning project denies access", async () => {
    mockLocalAccess.mockRejectedValue(Error("permission denied"));
    mockPreviewChange.mockResolvedValue({
      requires_course_access: true,
      requires_financial_approval: true,
    });
    await expect(
      client().previewPoolChange({
        terms: { ...change, action: "revise", amount_usd: "20" },
      }),
    ).rejects.toThrow("permission denied");
    expect(mockProposeChange).not.toHaveBeenCalled();
    expect(mockPreviewChange).toHaveBeenCalled();
  });

  it("leaves replay and version validation to the pool intent service", async () => {
    mockHasPoolChangeApproval.mockResolvedValue(true);
    mockPreviewChange.mockRejectedValue(Error("stale version"));
    await client().proposePoolChange({
      operation_id: operation,
      terms: change,
    });
    expect(mockPreviewChange).not.toHaveBeenCalled();
    expect(mockProposeChange).toHaveBeenCalledWith({
      payer_account_id: payer,
      operation_id: operation,
      terms: change,
    });
  });

  it.each(["cluster-role", "catalog"])(
    "discovers from every bay for multibay %s",
    async (mode) => {
      mockMultiBay = mode === "cluster-role";
      if (mode === "catalog") mockCatalog.push({ bay_id: "remote" });
      await expect(client(beneficiary).listSources()).resolves.toEqual({
        as_of: now.toISOString(),
        sources: [],
      });
      expect(mockRemote.computeFundingListSourcesOnBay).toHaveBeenCalledWith({
        beneficiary_account_id: beneficiary,
        beneficiary_home_bay_id: "home",
      });
      expect(mockRemoteClient).toHaveBeenCalledWith({
        client: {},
        dest_bay: "remote",
        timeout: 5000,
      });
    },
  );
  it("fails the complete discovery when a registered bay is missing", async () => {
    mockMultiBay = true;
    mockRemote.computeFundingListSourcesOnBay.mockRejectedValue(
      Error("remote unavailable"),
    );
    await expect(client(beneficiary).listSources()).rejects.toThrow(
      "remote unavailable",
    );
  });

  it("does not accept an empty registry as complete multibay discovery", async () => {
    mockMultiBay = true;
    mockRegistry.mockResolvedValue([]);
    await expect(client(beneficiary).listSources()).rejects.toThrow(
      "registry is incomplete",
    );
    expect(mockSourcesOnBay).not.toHaveBeenCalled();
  });

  it("fails closed when a stale pool copy names a payer home outside the bay list", async () => {
    mockSourcesOnBay.mockResolvedValue({
      as_of: now.toISOString(),
      sources: [],
      payer_home_bay_ids: ["missing-bay"],
    });
    await expect(client(beneficiary).listSources()).rejects.toThrow(
      "payer home is missing",
    );
  });

  it("keeps only public source fields and reports the oldest bay snapshot", async () => {
    mockMultiBay = true;
    const source = {
      pool_id: "pool",
      grant_id: "grant",
      payer_account_id: payer,
      label: "Course",
      lane: "prepaid",
      ...money,
      starts_at: terms.starts_at,
      ends_at: terms.ends_at,
      state: "active",
    };
    const earlier = "2026-09-12T09:59:59.000Z";
    mockRemote.computeFundingListSourcesOnBay.mockResolvedValue({
      as_of: earlier,
      sources: [source],
      payer_home_bay_ids: ["remote"],
    });
    expect(await client(beneficiary).listSources()).toEqual({
      as_of: earlier,
      sources: [source],
    });
  });

  it("fails conflicting duplicate authority instead of double-counting a grant", async () => {
    mockMultiBay = true;
    const snapshot = {
      as_of: now.toISOString(),
      sources: [{ pool_id: "pool", grant_id: "grant", label: "Course" }],
      payer_home_bay_ids: [],
    };
    mockSourcesOnBay.mockResolvedValue(snapshot);
    mockRemote.computeFundingListSourcesOnBay.mockResolvedValue(snapshot);
    await expect(client(beneficiary).listSources()).rejects.toThrow(
      "authority changed",
    );
  });
});
jest.mock("@cocalc/server/compute/funding/usage-projection", () => ({
  getCourseFundingUsageProjection: async () => new Map(),
}));
