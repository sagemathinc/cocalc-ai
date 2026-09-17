import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { initHubApi, transformArgs } from "@cocalc/conat/hub/api";
import type { CourseFundingPoolChangeDraft } from "@cocalc/conat/hub/api/compute-funding";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import * as handlers from "@cocalc/server/conat/api/compute-funding";
import { withFundingAccountTransaction } from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import { normalizeCourseFundingPoolChangeDraft } from "./pool-changes";
import { resolveCourseFundingReview } from "./approval-review";
import {
  createCourseFundingApprovals,
  ensureCourseFundingApprovalSchema,
  registerCourseFundingApprovalService,
} from "./approvals";

const mockProjectBay = jest.fn();
const mockProjectAccess = jest.fn();
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args) => mockProjectBay(...args),
}));
jest.mock("@cocalc/server/conat/project-local-access", () => ({
  assertLocalProjectCollaborator: (...args) => mockProjectAccess(...args),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({
    home_bay_id: require("@cocalc/server/bay-config").getConfiguredBayId(),
  }),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: async (account_id: string) => ({
    account_id,
    home_bay_id: require("@cocalc/server/bay-config").getConfiguredBayId(),
  }),
  getClusterAccountsByIds: async (ids: string[]) =>
    ids.map((account_id) => ({
      account_id,
      email_address: `${account_id}@example.test`,
      home_bay_id: require("@cocalc/server/bay-config").getConfiguredBayId(),
    })),
}));
jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
jest.mock("@cocalc/server/compute/funding/rollout", () => ({
  assertSponsorshipAdmission: async () => ({ checked_at: new Date() }),
  getSponsorshipAvailability: async () => ({
    enabled: true,
    available: true,
  }),
}));

let unregister: () => void;
beforeAll(async () => {
  await before({ noConat: true });
  await ensureCourseFundingApprovalSchema();
  unregister = registerCourseFundingApprovalService(
    createCourseFundingApprovals({
      approval_origin: "https://approve.example.test",
      validateTerms: (input) =>
        normalizeCourseFundingPoolChangeDraft(
          input as CourseFundingPoolChangeDraft,
        ),
      resolveReview: resolveCourseFundingReview,
      apply: async () => {
        throw Error("Public RPC must never apply approval");
      },
    }),
  );
}, 60_000);
afterAll(async () => {
  unregister?.();
  await after();
});

function client(account_id: string) {
  return initHubApi(async ({ name, args }) => {
    const transformed = await transformArgs({
      name,
      args: structuredClone(args),
      account_id,
    });
    return await handlers[name.split(".")[1] as keyof typeof handlers](
      transformed[0],
    );
  }).computeFunding;
}

async function fixture() {
  const payer = randomUUID(),
    student = randomUUID(),
    outsider = randomUUID();
  await getPool().query(
    "INSERT INTO accounts(account_id) VALUES ($1),($2),($3)",
    [payer, student, outsider],
  );
  await getPool().query(
    "INSERT INTO purchases(account_id,cost,service,time) VALUES ($1,-1000,'credit',now())",
    [payer],
  );
  const allocation = await withFundingAccountTransaction(payer, (db) =>
    createCourseFundingPoolInTransaction(db, {
      payer_account_id: payer,
      operation_id: randomUUID(),
      terms: {
        course_project_id: randomUUID(),
        course_instance_id: randomUUID(),
        currency: "USD",
        lane: "prepaid",
        amount_usd: "100",
        allow_overcommit: false,
        starts_at: new Date(Date.now() - 86_400_000).toISOString(),
        ends_at: new Date(Date.now() + 86_400_000).toISOString(),
        recipients: [{ beneficiary_account_id: student, amount_usd: "100" }],
      },
    }),
  );
  const course = {
    course_project_id: allocation.pool.course_project_id,
    course_instance_id: allocation.pool.course_instance_id,
  };
  const base = {
    ...course,
    pool_id: allocation.pool.id,
    expected_version: allocation.pool.version,
  };
  const grant = allocation.grants[0];
  return { payer, student, outsider, allocation, course, base, grant };
}

it.each(["deleted", "removed collaborator"])(
  "lets only the stored payer read/reduce/revoke/close after %s",
  async (mode) => {
    const f = await fixture();
    mockProjectBay
      .mockReset()
      .mockResolvedValue(
        mode === "deleted" ? undefined : { bay_id: getConfiguredBayId() },
      );
    mockProjectAccess
      .mockReset()
      .mockRejectedValue(Error("course access removed"));
    expect(
      (await client(f.payer).getCourseSummary(f.course)).pools.map((p) => p.id),
    ).toEqual([f.base.pool_id]);
    const owned = await client(f.payer).getOwnedPools();
    expect(owned.pools.map((p) => p.id)).toEqual([f.base.pool_id]);
    expect(owned.pools[0]).toMatchObject(f.course);
    for (const actor of [f.student, f.outsider])
      expect((await client(actor).getCourseSummary(f.course)).pools).toEqual(
        [],
      );
    for (const actor of [f.student, f.outsider])
      expect((await client(actor).getOwnedPools()).pools).toEqual([]);
    const current = async () =>
      (await client(f.payer).getCourseSummary(f.course)).pools[0];
    const requests: CourseFundingPoolChangeDraft[] = [];
    let latest = await current();
    requests.push({
      ...f.base,
      expected_version: latest.version!,
      action: "revise",
      amount_usd: "50",
      grants: [
        {
          grant_id: latest.grants[0].id,
          expected_version: latest.grants[0].version!,
          action: "revise",
          amount_usd: "50",
        },
      ],
    });
    for (const terms of requests) {
      const preview = await client(f.payer).previewPoolChange({ terms });
      expect(preview.requires_course_access).toBe(false);
      expect(preview.requires_financial_approval).toBe(false);
      const operation_id = randomUUID();
      const proposed = await client(f.payer).proposePoolChange({
        terms,
        operation_id,
      });
      expect(proposed).toMatchObject({
        status: "approved",
        pool_id: f.base.pool_id,
      });
      expect(
        await client(f.payer).proposePoolChange({ terms, operation_id }),
      ).toEqual(proposed);
    }
    latest = await current();
    const revoke: CourseFundingPoolChangeDraft = {
      ...f.base,
      expected_version: latest.version!,
      action: "revise",
      grants: [
        {
          grant_id: latest.grants[0].id,
          expected_version: latest.grants[0].version!,
          action: "revoke",
        },
      ],
    };
    await expect(
      client(f.payer).proposePoolChange({
        terms: revoke,
        operation_id: randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "approved" });
    latest = await current();
    await expect(
      client(f.payer).proposePoolChange({
        terms: {
          ...f.base,
          expected_version: latest.version!,
          action: "close",
        },
        operation_id: randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "approved" });
    for (const actor of [f.student, f.outsider]) {
      await expect(
        client(actor).previewPoolChange({
          terms: {
            ...f.base,
            action: "close",
          },
        }),
      ).rejects.toMatchObject({ code: "funding_not_found" });
    }
    expect(mockProjectBay).not.toHaveBeenCalled();
    expect(mockProjectAccess).not.toHaveBeenCalled();
    expect(
      (await client(f.payer).getCourseSummary(f.course)).pools[0]
        .authorized_usd,
    ).toBe("100.0000000000");
  },
);

it("returns only the beneficiary's authoritative pool-limited source through the registered handler", async () => {
  const f = await fixture();
  await getPool().query(
    "UPDATE compute_funding_pools SET allow_overcommit=true,reserved_usd=95 WHERE id=$1",
    [f.base.pool_id],
  );
  const result = await client(f.student).listSources({
    include_inactive: true,
  });
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]).toMatchObject({
    pool_id: f.base.pool_id,
    grant_id: f.grant.id,
    authorized_usd: "100.0000000000",
    reserved_usd: "0.0000000000",
    available_usd: "5.0000000000",
    available_for_new_resources: true,
  });
  expect(
    (await client(f.outsider).listSources({ include_inactive: true })).sources,
  ).toEqual([]);
  await getPool().query(
    "UPDATE compute_funding_pools SET reserved_usd=100 WHERE id=$1",
    [f.base.pool_id],
  );
  expect((await client(f.student).listSources()).sources[0]).toMatchObject({
    available_usd: "0",
    available_for_new_resources: false,
  });
});

it("requires isolated approval only when the aggregate pool envelope expands", async () => {
  const f = await fixture();
  mockProjectBay
    .mockReset()
    .mockResolvedValue({ bay_id: getConfiguredBayId() });
  mockProjectAccess.mockReset().mockResolvedValue(undefined);
  const withinEnvelope: CourseFundingPoolChangeDraft = {
    ...f.base,
    action: "revise",
    amount_usd: "80",
    grants: [
      {
        grant_id: f.grant.id,
        expected_version: f.grant.version,
        action: "revise",
        amount_usd: "80",
      },
    ],
  };
  expect(
    (await client(f.payer).previewPoolChange({ terms: withinEnvelope }))
      .requires_financial_approval,
  ).toBe(false);
  await expect(
    client(f.payer).proposePoolChange({
      operation_id: randomUUID(),
      terms: withinEnvelope,
    }),
  ).resolves.toMatchObject({ status: "approved", pool_id: f.base.pool_id });

  let current = (await client(f.payer).getCourseSummary(f.course)).pools[0];
  const increaseStudentWithinEnvelope: CourseFundingPoolChangeDraft = {
    ...f.base,
    expected_version: current.version!,
    action: "revise",
    amount_usd: "100",
    grants: [
      {
        grant_id: current.grants[0].id,
        expected_version: current.grants[0].version!,
        action: "revise",
        amount_usd: "95",
      },
    ],
  };
  expect(
    (
      await client(f.payer).previewPoolChange({
        terms: increaseStudentWithinEnvelope,
      })
    ).requires_financial_approval,
  ).toBe(false);
  await expect(
    client(f.payer).proposePoolChange({
      operation_id: randomUUID(),
      terms: increaseStudentWithinEnvelope,
    }),
  ).resolves.toMatchObject({ status: "approved" });

  current = (await client(f.payer).getCourseSummary(f.course)).pools[0];
  expect(current).toMatchObject({
    approval_limit_usd: "100.0000000000",
  });
  const expanded: CourseFundingPoolChangeDraft = {
    ...f.base,
    expected_version: current.version!,
    action: "revise",
    amount_usd: "120",
  };
  const preview = await client(f.payer).previewPoolChange({ terms: expanded });
  expect(preview.requires_financial_approval).toBe(true);
  await expect(
    client(f.payer).proposePoolChange({
      operation_id: randomUUID(),
      terms: expanded,
    }),
  ).resolves.toMatchObject({
    status: "pending",
    approval_url: expect.stringContaining(
      "https://approve.example.test/funding/",
    ),
  });
});

it("allows dates to move inside their approved window but authorizes an extension", async () => {
  const f = await fixture();
  mockProjectBay
    .mockReset()
    .mockResolvedValue({ bay_id: getConfiguredBayId() });
  mockProjectAccess.mockReset().mockResolvedValue(undefined);
  const originalEnd = f.allocation.pool.ends_at.toISOString();
  const shorterEnd = new Date(
    f.allocation.pool.ends_at.getTime() - 3_600_000,
  ).toISOString();
  const shorter: CourseFundingPoolChangeDraft = {
    ...f.base,
    action: "revise",
    ends_at: shorterEnd,
    grants: [
      {
        grant_id: f.grant.id,
        expected_version: f.grant.version,
        action: "revise",
        ends_at: shorterEnd,
      },
    ],
  };
  await expect(
    client(f.payer).proposePoolChange({
      operation_id: randomUUID(),
      terms: shorter,
    }),
  ).resolves.toMatchObject({ status: "approved" });
  let current = (await client(f.payer).getCourseSummary(f.course)).pools[0];
  const restore: CourseFundingPoolChangeDraft = {
    ...f.base,
    expected_version: current.version!,
    action: "revise",
    ends_at: originalEnd,
    grants: [
      {
        grant_id: current.grants[0].id,
        expected_version: current.grants[0].version!,
        action: "revise",
        ends_at: originalEnd,
      },
    ],
  };
  expect(
    (await client(f.payer).previewPoolChange({ terms: restore }))
      .requires_financial_approval,
  ).toBe(false);
  await client(f.payer).proposePoolChange({
    operation_id: randomUUID(),
    terms: restore,
  });
  current = (await client(f.payer).getCourseSummary(f.course)).pools[0];
  const extendedEnd = new Date(
    f.allocation.pool.ends_at.getTime() + 3_600_000,
  ).toISOString();
  const extend: CourseFundingPoolChangeDraft = {
    ...f.base,
    expected_version: current.version!,
    action: "revise",
    ends_at: extendedEnd,
    grants: [
      {
        grant_id: current.grants[0].id,
        expected_version: current.grants[0].version!,
        action: "revise",
        ends_at: extendedEnd,
      },
    ],
  };
  expect(
    (await client(f.payer).previewPoolChange({ terms: extend }))
      .requires_financial_approval,
  ).toBe(true);
});

it("requires owning-project permission for pool/grant increases or expanded dates at preview and proposal", async () => {
  const f = await fixture();
  mockProjectBay
    .mockReset()
    .mockResolvedValue({ bay_id: getConfiguredBayId() });
  mockProjectAccess
    .mockReset()
    .mockRejectedValue(Error("course access removed"));
  const requests: CourseFundingPoolChangeDraft[] = [
    { ...f.base, action: "revise", amount_usd: "110" },
    {
      ...f.base,
      action: "revise",
      starts_at: new Date(Date.now() - 172_800_000).toISOString(),
    },
    {
      ...f.base,
      action: "revise",
      ends_at: new Date(Date.now() + 172_800_000).toISOString(),
    },
  ];
  // An overcommitted grant increase must still require project permission even
  // when it does not need more pool backing.
  await getPool().query(
    "UPDATE compute_funding_pools SET allow_overcommit=true WHERE id=$1",
    [f.base.pool_id],
  );
  requests.push({
    ...f.base,
    action: "revise",
    grants: [
      {
        grant_id: f.grant.id,
        expected_version: f.grant.version,
        action: "revise",
        amount_usd: "110",
      },
    ],
  });
  for (const terms of requests) {
    await expect(client(f.payer).previewPoolChange({ terms })).rejects.toThrow(
      "course access removed",
    );
    await expect(
      client(f.payer).proposePoolChange({ terms, operation_id: randomUUID() }),
    ).rejects.toThrow("course access removed");
  }
  expect(mockProjectAccess).toHaveBeenCalledWith({
    account_id: f.payer,
    project_id: f.course.course_project_id,
  });
});
