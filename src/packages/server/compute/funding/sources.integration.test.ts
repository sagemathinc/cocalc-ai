import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { CourseFundingDraft } from "@cocalc/util/compute-funding";
import { withFundingAccountTransaction } from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import { listCourseFundingSourcesOnBay } from "./sources";
import { setCourseVmRecommendations } from "./course-vm-recommendations";

const mockHomes = new Map<string, string>();
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: async (account_id: string) =>
    mockHomes.has(account_id)
      ? { account_id, home_bay_id: mockHomes.get(account_id) }
      : null,
  getClusterAccountsByIds: async (ids: string[]) =>
    ids
      .filter((id) => mockHomes.has(id))
      .map((account_id) => ({
        account_id,
        home_bay_id: mockHomes.get(account_id),
      })),
}));
jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);

beforeAll(async () => await before({ noConat: true }), 60_000);
afterAll(after);

it("reads isolated beneficiary budgets from real pool/grant tables and excludes rehomed payer copies", async () => {
  const payer = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  const project = randomUUID();
  const local = getConfiguredBayId();
  mockHomes.set(payer, local);
  mockHomes.set(first, "student-home");
  mockHomes.set(second, "student-home");
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1)", [
    payer,
  ]);
  await getPool().query(
    "INSERT INTO purchases (account_id, cost, service, time) VALUES ($1,-100,'credit',now())",
    [payer],
  );
  await getPool().query(
    "INSERT INTO projects (project_id,title) VALUES ($1,'Calculus')",
    [project],
  );
  const terms: CourseFundingDraft = {
    course_project_id: project,
    course_instance_id: randomUUID(),
    currency: "USD",
    lane: "prepaid",
    amount_usd: "100",
    allow_overcommit: false,
    starts_at: new Date(Date.now() - 1000).toISOString(),
    ends_at: new Date(Date.now() + 86400000).toISOString(),
    recipients: [
      { beneficiary_account_id: first, amount_usd: "40" },
      { beneficiary_account_id: second, amount_usd: "60" },
    ],
  };
  const allocation = await withFundingAccountTransaction(
    payer,
    async (db) =>
      await createCourseFundingPoolInTransaction(db, {
        payer_account_id: payer,
        operation_id: randomUUID(),
        terms,
      }),
  );
  const instructor = randomUUID();
  await getPool().query(
    "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
    [project, JSON.stringify({ [instructor]: { group: "collaborator" } })],
  );
  const { templates } = await setCourseVmRecommendations({
    account_id: instructor,
    course_project_id: project,
    course_instance_id: terms.course_instance_id,
    expected_version: 0,
    templates: [
      {
        id: "notebook",
        label: "Notebook CPU",
        config: {
          provider: "gcp",
          operating_system: "linux",
          architecture: "x86_64",
          region: "us-west1",
          machine_type: "e2-standard-2",
          gpu_count: 0,
          pricing_model: "on_demand",
          boot_disk_gb: 20,
        },
      },
    ],
  });
  const result = await listCourseFundingSourcesOnBay({
    beneficiary_account_id: first,
    beneficiary_home_bay_id: "student-home",
  });
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]).toMatchObject({
    pool_id: allocation.pool.id,
    payer_account_id: payer,
    label: "Calculus",
    authorized_usd: "40.0000000000",
  });
  expect(result.sources[0].grant_id).toBe(
    allocation.grants.find((g) => g.beneficiary_account_id === first)!.id,
  );
  expect(JSON.stringify(result.sources)).not.toContain(second);
  expect(result.sources[0]).not.toHaveProperty("hold_id");
  // A grant recipient without course-project access receives only the published
  // hardware suggestions, never another grant's data or project authority.
  expect(result.sources[0].recommended_vm_templates).toEqual(templates);
  expect(result.sources[0]).not.toHaveProperty("course_project_id");
  expect(result.sources[0]).not.toHaveProperty("course_instance_id");
  expect(Number.isFinite(Date.parse(result.as_of))).toBe(true);
  expect(result.sources[0]).toMatchObject({
    pool_state: "active",
    available_for_new_resources: true,
    available_usd: "40.0000000000",
  });

  // Shared pool capacity, not the individual ceiling, limits new admissions.
  await getPool().query(
    "UPDATE compute_funding_pools SET allow_overcommit=true,reserved_usd=95 WHERE id=$1",
    [allocation.pool.id],
  );
  const limited = await listCourseFundingSourcesOnBay({
    beneficiary_account_id: first,
    beneficiary_home_bay_id: "student-home",
  });
  expect(limited.sources[0]).toMatchObject({
    authorized_usd: "40.0000000000",
    available_usd: "5.0000000000",
    available_for_new_resources: true,
  });
  expect(JSON.stringify(limited.sources)).not.toContain(second);
  await getPool().query(
    "UPDATE compute_funding_pools SET reserved_usd=0 WHERE id=$1",
    [allocation.pool.id],
  );

  for (const state of ["exhausted", "expired", "revoked"]) {
    await getPool().query(
      "UPDATE compute_funding_grants SET state=$2 WHERE id=$1",
      [result.sources[0].grant_id, state],
    );
    const history = await listCourseFundingSourcesOnBay({
      beneficiary_account_id: first,
      beneficiary_home_bay_id: "student-home",
      include_inactive: true,
    });
    expect(history.sources).toHaveLength(1);
    expect(history.sources[0]).toMatchObject({
      state,
      available_for_new_resources: false,
    });
    expect(JSON.stringify(history.sources)).not.toContain(second);
    expect(
      (
        await listCourseFundingSourcesOnBay({
          beneficiary_account_id: first,
          beneficiary_home_bay_id: "student-home",
        })
      ).sources,
    ).toEqual([]);
  }
  await getPool().query(
    "UPDATE compute_funding_grants SET state='active' WHERE id=$1",
    [result.sources[0].grant_id],
  );
  for (const state of ["closing", "closed", "suspended"]) {
    await getPool().query(
      "UPDATE compute_funding_pools SET state=$2,released_usd=CASE WHEN $2='closed' THEN 100 ELSE 0 END WHERE id=$1",
      [allocation.pool.id, state],
    );
    const history = await listCourseFundingSourcesOnBay({
      beneficiary_account_id: first,
      beneficiary_home_bay_id: "student-home",
      include_inactive: true,
    });
    expect(history.sources[0]).toMatchObject({
      state: "active",
      pool_state: state,
      available_for_new_resources: false,
    });
  }
  await getPool().query(
    "UPDATE compute_funding_pools SET state='active',reserved_usd=100 WHERE id=$1",
    [allocation.pool.id],
  );
  expect(
    (
      await listCourseFundingSourcesOnBay({
        beneficiary_account_id: first,
        beneficiary_home_bay_id: "student-home",
      })
    ).sources[0].available_for_new_resources,
  ).toBe(false);
  await getPool().query(
    "UPDATE compute_funding_pools SET reserved_usd=0 WHERE id=$1",
    [allocation.pool.id],
  );

  mockHomes.set(payer, "successor");
  const moved = await listCourseFundingSourcesOnBay({
    beneficiary_account_id: first,
    beneficiary_home_bay_id: "student-home",
  });
  expect(moved.sources).toEqual([]);
  expect(moved.payer_home_bay_ids).toEqual(["successor"]);
});
