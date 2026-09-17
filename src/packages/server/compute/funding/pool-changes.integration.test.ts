import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { CourseFundingPoolChangeDraft } from "@cocalc/conat/hub/api/compute-funding";
import {
  withFundingAccountTransaction,
  getAccountFundingBacking,
} from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import {
  changeCourseFundingPoolInTransaction,
  changeCourseFundingPoolWithinEnvelopeInTransaction,
  previewCourseFundingPoolChangeInTransaction,
} from "./pool-changes";
import { ensureCourseFundingApprovalSchema } from "./approvals";
import { setPolicyFailure } from "./__tests__/policy-source";
import { finalizeClosingCourseFundingPoolInTransaction } from "./pool-lifecycle";
import { finalizeSettledCourseFundingPools } from "./pool-lifecycle-worker";

const mockReceiptHomes = new Map<string, string>();
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountsByIds: async (ids: string[]) =>
    ids.map((account_id) => ({
      account_id,
      home_bay_id:
        mockReceiptHomes.get(account_id) ??
        require("@cocalc/server/bay-config").getConfiguredBayId(),
    })),
}));

jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
beforeAll(async () => {
  await before({ noConat: true });
  await ensureCourseFundingApprovalSchema();
}, 60_000);
afterAll(after);

async function fixture() {
  const payer = randomUUID(),
    first = randomUUID(),
    second = randomUUID();
  await getPool().query(
    "INSERT INTO accounts (account_id) VALUES ($1),($2),($3)",
    [payer, first, second],
  );
  await getPool().query(
    "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,-1000,'credit',now())",
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
        starts_at: new Date(Date.now() - 1000).toISOString(),
        ends_at: new Date(Date.now() + 86400000).toISOString(),
        recipients: [
          { beneficiary_account_id: first, amount_usd: "40" },
          { beneficiary_account_id: second, amount_usd: "60" },
        ],
      },
    }),
  );
  const grant = allocation.grants.find(
    (g) => g.beneficiary_account_id === first,
  )!;
  const base = {
    course_project_id: allocation.pool.course_project_id,
    course_instance_id: allocation.pool.course_instance_id,
    pool_id: allocation.pool.id,
    expected_version: allocation.pool.version,
  };
  const homes = {
    [payer]: getConfiguredBayId(),
    [first]: getConfiguredBayId(),
    [second]: getConfiguredBayId(),
  };
  const apply = async (
    terms: CourseFundingPoolChangeDraft,
    receiptHomes = homes,
  ) =>
    withFundingAccountTransaction(payer, (db) =>
      changeCourseFundingPoolInTransaction(db, {
        payer_account_id: payer,
        operation_id: randomUUID(),
        terms,
        home_bay_by_account_id: receiptHomes,
      }),
    );
  const pool = async () =>
    (
      await getPool().query("SELECT * FROM compute_funding_pools WHERE id=$1", [
        allocation.pool.id,
      ])
    ).rows[0];
  const backing = async () =>
    withFundingAccountTransaction(payer, (db) =>
      getAccountFundingBacking(db, payer),
    );
  return {
    payer,
    first,
    second,
    allocation,
    grant,
    base,
    homes,
    apply,
    pool,
    backing,
  };
}

it("previews exact totals without mutation, then increases backed pool and student ceiling with durable receipts", async () => {
  const f = await fixture();
  const terms: CourseFundingPoolChangeDraft = {
    ...f.base,
    action: "revise",
    amount_usd: "120",
    grants: [
      {
        grant_id: f.grant.id,
        expected_version: f.grant.version,
        action: "revise",
        amount_usd: "60",
      },
    ],
  };
  const preview = await withFundingAccountTransaction(f.payer, (db) =>
    previewCourseFundingPoolChangeInTransaction(db, {
      payer_account_id: f.payer,
      terms,
    }),
  );
  expect(preview.pool.authorized_usd).toBe("120.0000000000");
  expect((await f.pool()).authorized_usd).toBe("100.0000000000");
  await f.apply(terms);
  expect(await f.pool()).toMatchObject({
    approval_limit_usd: "120.0000000000",
  });
  expect((await f.backing()).prepaid_held_usd).toBe("120.0000000000");
  const { rows } = await getPool().query(
    "SELECT * FROM notification_target_outbox WHERE target_account_id=ANY($1::uuid[])",
    [[f.payer, f.first, f.second]],
  );
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.published_at == null)).toBe(true);
  expect(
    JSON.stringify(
      rows.find((r) => r.target_account_id === f.first).payload_json,
    ),
  ).not.toContain(f.second);
  await expect(f.apply(terms)).rejects.toMatchObject({
    code: "funding_conflict",
  });
});

it("serializes direct envelope edits and replays only the committed operation", async () => {
  const f = await fixture();
  const terms: CourseFundingPoolChangeDraft = {
    ...f.base,
    action: "revise",
    amount_usd: "80",
    grants: f.allocation.grants.map((grant) => ({
      grant_id: grant.id,
      expected_version: grant.version,
      action: "revise" as const,
      amount_usd: grant.id === f.grant.id ? "30" : "50",
    })),
  };
  const operation_id = randomUUID();
  const apply = (id: string) =>
    withFundingAccountTransaction(f.payer, (db) =>
      changeCourseFundingPoolWithinEnvelopeInTransaction(db, {
        payer_account_id: f.payer,
        operation_id: id,
        terms,
        home_bay_by_account_id: f.homes,
      }),
    );
  const outcomes = await Promise.all([
    apply(operation_id),
    apply(operation_id),
  ]);
  expect(outcomes[0]).toEqual(outcomes[1]);
  await expect(apply(randomUUID())).rejects.toMatchObject({
    code: "funding_conflict",
  });
  const committed = await apply(operation_id);
  expect(committed.pool_id).toBe(f.base.pool_id);
  expect(await f.pool()).toMatchObject({
    version: f.base.expected_version + 1,
    approval_limit_usd: "100.0000000000",
  });
  const { rows } = await getPool().query(
    "SELECT operation_id FROM course_funding_pool_changes WHERE payer_account_id=$1",
    [f.payer],
  );
  expect(rows).toEqual([{ operation_id }]);
});

it("revokes only a student's uncommitted capacity without returning earmarked pool money to the payer", async () => {
  const f = await fixture();
  await f.apply({
    ...f.base,
    action: "revise",
    grants: [
      {
        grant_id: f.grant.id,
        expected_version: f.grant.version,
        action: "revoke",
      },
    ],
  });
  const {
    rows: [grant],
  } = await getPool().query(
    "SELECT * FROM compute_funding_grants WHERE id=$1",
    [f.grant.id],
  );
  expect(grant).toMatchObject({
    state: "revoked",
    released_usd: "40.0000000000",
  });
  expect((await f.backing()).prepaid_held_usd).toBe("100.0000000000");
});

it("closes an unused pool and releases its backing even when eligibility is lost", async () => {
  const f = await fixture();
  setPolicyFailure(f.payer, Error("policy unavailable"));
  try {
    await f.apply({ ...f.base, action: "close" });
    expect(await f.pool()).toMatchObject({
      state: "closed",
      released_usd: "100.0000000000",
    });
    expect((await f.backing()).prepaid_held_usd).toBe("0.0000000000");
  } finally {
    setPolicyFailure(f.payer);
  }
});

it("keeps incurred and uncertain resource liabilities backed while a pool closes", async () => {
  const f = await fixture();
  await getPool().query(
    "UPDATE compute_funding_pools SET spent_usd=10,reserved_usd=20 WHERE id=$1",
    [f.base.pool_id],
  );
  await getPool().query(
    "UPDATE compute_funding_grants SET spent_usd=10,reserved_usd=20 WHERE id=$1",
    [f.grant.id],
  );
  await getPool().query(
    "UPDATE account_funding_holds SET remaining_usd=90 WHERE id=$1",
    [f.allocation.pool.hold_id],
  );
  await f.apply({ ...f.base, action: "close" });
  expect(await f.pool()).toMatchObject({
    state: "closing",
    spent_usd: "10.0000000000",
    reserved_usd: "20.0000000000",
    released_usd: "70.0000000000",
  });
  expect((await f.backing()).prepaid_held_usd).toBe("20.0000000000");
});

it("rolls back a budget/backing change if a mandatory receipt cannot be routed", async () => {
  const f = await fixture();
  await expect(
    f.apply(
      { ...f.base, action: "revise", amount_usd: "120" },
      { [f.payer]: getConfiguredBayId() },
    ),
  ).rejects.toThrow("resolved home bay");
  expect(await f.pool()).toMatchObject({
    authorized_usd: "100.0000000000",
    version: f.base.expected_version,
  });
  expect((await f.backing()).prepaid_held_usd).toBe("100.0000000000");
});

it("rejects pool ceilings below unchanged student ceilings", async () => {
  const f = await fixture();
  await expect(
    f.apply({ ...f.base, action: "revise", amount_usd: "80" }),
  ).rejects.toThrow("Student ceilings exceed");
});

it("rejects stale grant versions and grants from another pool", async () => {
  const f = await fixture();
  await expect(
    f.apply({
      ...f.base,
      action: "revise",
      grants: [
        {
          grant_id: f.grant.id,
          expected_version: f.grant.version + 1,
          action: "revoke",
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "funding_conflict" });
  await expect(
    f.apply({
      ...f.base,
      action: "revise",
      grants: [
        { grant_id: randomUUID(), expected_version: 1, action: "revoke" },
      ],
    }),
  ).rejects.toThrow("does not belong");
});

it("does not disclose or mutate a different payer's pool", async () => {
  const f = await fixture();
  await expect(
    withFundingAccountTransaction(f.first, (db) =>
      previewCourseFundingPoolChangeInTransaction(db, {
        payer_account_id: f.first,
        terms: { ...f.base, action: "close" },
      }),
    ),
  ).rejects.toMatchObject({ code: "funding_not_found" });
});

it("reduces exact bulk totals and preserves release history on a later increase", async () => {
  const f = await fixture();
  await f.apply({
    ...f.base,
    action: "revise",
    amount_usd: "80",
    grants: f.allocation.grants.map((g) => ({
      grant_id: g.id,
      expected_version: g.version,
      action: "revise",
      amount_usd: g.id === f.grant.id ? "30" : "50",
    })),
  });
  expect(await f.pool()).toMatchObject({
    authorized_usd: "100.0000000000",
    released_usd: "20.0000000000",
  });
  expect((await f.backing()).prepaid_held_usd).toBe("80.0000000000");
  await f.apply({
    ...f.base,
    expected_version: f.base.expected_version + 1,
    action: "revise",
    amount_usd: "100",
  });
  expect(await f.pool()).toMatchObject({
    authorized_usd: "120.0000000000",
    released_usd: "20.0000000000",
  });
  expect((await f.backing()).prepaid_held_usd).toBe("100.0000000000");
});

it("extends pool and student dates together but rejects dates outside pool bounds", async () => {
  const f = await fixture();
  const ends_at = new Date(Date.now() + 172800000).toISOString();
  const grants = f.allocation.grants.map((g) => ({
    grant_id: g.id,
    expected_version: g.version,
    action: "revise" as const,
    ends_at,
  }));
  await expect(
    f.apply({ ...f.base, action: "revise", grants }),
  ).rejects.toThrow("Grant dates must fit");
  await f.apply({ ...f.base, action: "revise", ends_at, grants });
  expect((await f.pool()).ends_at.toISOString()).toBe(ends_at);
  const { rows } = await getPool().query(
    "SELECT ends_at,version FROM compute_funding_grants WHERE pool_id=$1",
    [f.base.pool_id],
  );
  expect(
    rows.every((r) => r.ends_at.toISOString() === ends_at && r.version === 2),
  ).toBe(true);
});

it("refuses budget reductions and shortened dates that strand reserved liabilities", async () => {
  const f = await fixture();
  await getPool().query(
    "UPDATE compute_funding_pools SET reserved_usd=20 WHERE id=$1",
    [f.base.pool_id],
  );
  await getPool().query(
    "UPDATE compute_funding_grants SET reserved_usd=20 WHERE id=$1",
    [f.grant.id],
  );
  await expect(
    f.apply({ ...f.base, action: "revise", amount_usd: "10" }),
  ).rejects.toThrow("spent and reserved");
  await expect(
    f.apply({
      ...f.base,
      action: "revise",
      ends_at: new Date(Date.now() + 3600000).toISOString(),
    }),
  ).rejects.toThrow("before shortening");
  expect((await f.pool()).version).toBe(1);
});

it("versions automatic grant state transitions during a pool revision", async () => {
  const f = await fixture();
  await getPool().query(
    "UPDATE compute_funding_grants SET state='scheduled' WHERE id=$1",
    [f.grant.id],
  );
  await f.apply({ ...f.base, action: "revise", amount_usd: "110" });
  const {
    rows: [grant],
  } = await getPool().query(
    "SELECT state,version FROM compute_funding_grants WHERE id=$1",
    [f.grant.id],
  );
  expect(grant).toEqual({ state: "active", version: 2 });
});

it("finalizes a closing pool only after trusted settlement and releases the unspent remainder exactly once", async () => {
  const f = await fixture();
  await getPool().query(
    "UPDATE compute_funding_pools SET reserved_usd=20 WHERE id=$1",
    [f.base.pool_id],
  );
  await getPool().query(
    "UPDATE compute_funding_grants SET reserved_usd=20 WHERE id=$1",
    [f.grant.id],
  );
  await f.apply({ ...f.base, action: "close" });
  const operation_id = randomUUID();
  const finish = () =>
    withFundingAccountTransaction(f.payer, (db) =>
      finalizeClosingCourseFundingPoolInTransaction(db, {
        payer_account_id: f.payer,
        pool_id: f.base.pool_id,
        operation_id,
        home_bay_by_account_id: f.homes,
      }),
    );
  expect(await finish()).toBe(false);
  expect((await f.backing()).prepaid_held_usd).toBe("20.0000000000");
  await getPool().query(
    "UPDATE compute_funding_pools SET reserved_usd=0,spent_usd=5 WHERE id=$1",
    [f.base.pool_id],
  );
  await getPool().query(
    "UPDATE compute_funding_grants SET reserved_usd=0,spent_usd=5 WHERE id=$1",
    [f.grant.id],
  );
  await getPool().query(
    "UPDATE account_funding_holds SET remaining_usd=15 WHERE id=$1",
    [f.allocation.pool.hold_id],
  );
  expect(await finish()).toBe(true);
  expect(await f.pool()).toMatchObject({
    state: "closed",
    spent_usd: "5.0000000000",
    released_usd: "95.0000000000",
  });
  expect((await f.backing()).prepaid_held_usd).toBe("0.0000000000");
  expect(await finish()).toBe(false);
  const { rows } = await getPool().query(
    "SELECT target_account_id FROM notification_target_outbox WHERE target_account_id=$1",
    [f.payer],
  );
  expect(rows).toHaveLength(2);
});

it("automatically closes expired, settled pools and returns instructor backing exactly once", async () => {
  const f = await fixture();
  await getPool().query(
    "UPDATE compute_funding_pools SET starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' WHERE id=$1",
    [f.base.pool_id],
  );
  await getPool().query(
    "UPDATE compute_funding_grants SET starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' WHERE pool_id=$1",
    [f.base.pool_id],
  );
  await finalizeSettledCourseFundingPools();
  expect(await f.pool()).toMatchObject({
    state: "closed",
    released_usd: "100.0000000000",
  });
  expect((await f.backing()).prepaid_held_usd).toBe("0.0000000000");
  await finalizeSettledCourseFundingPools();
  const { rows } = await getPool().query(
    `SELECT e.payload_json FROM notification_events e
    JOIN notification_targets t USING(event_id) WHERE t.target_account_id=$1`,
    [f.payer],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].payload_json.funding_receipt.action).toBe("expired");
  expect(
    (
      await getPool().query(
        "SELECT state FROM compute_funding_grants WHERE pool_id=$1",
        [f.base.pool_id],
      )
    ).rows.every((g) => g.state === "expired"),
  ).toBe(true);
});

it("does not close unexpired pools or change expired pools with unsettled liabilities", async () => {
  const f = await fixture();
  const finish = () =>
    withFundingAccountTransaction(f.payer, (db) =>
      finalizeClosingCourseFundingPoolInTransaction(db, {
        payer_account_id: f.payer,
        pool_id: f.base.pool_id,
        operation_id: randomUUID(),
        home_bay_by_account_id: f.homes,
      }),
    );
  expect(await finish()).toBe(false);
  await getPool().query(
    "UPDATE compute_funding_pools SET reserved_usd=20,starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' WHERE id=$1",
    [f.base.pool_id],
  );
  await getPool().query(
    "UPDATE compute_funding_grants SET reserved_usd=20 WHERE id=$1",
    [f.grant.id],
  );
  expect(await finish()).toBe(false);
  await finalizeSettledCourseFundingPools();
  expect(await f.pool()).toMatchObject({
    state: "active",
    reserved_usd: "20.0000000000",
    released_usd: "0.0000000000",
  });
  expect((await f.backing()).prepaid_held_usd).toBe("100.0000000000");
});

it("the registered worker sweep returns backing and retries after unavailable recipient routing", async () => {
  const f = await fixture();
  await getPool().query(
    "UPDATE compute_funding_pools SET reserved_usd=20 WHERE id=$1",
    [f.base.pool_id],
  );
  await getPool().query(
    "UPDATE compute_funding_grants SET reserved_usd=20 WHERE id=$1",
    [f.grant.id],
  );
  await f.apply({ ...f.base, action: "close" });
  await getPool().query(
    "UPDATE compute_funding_pools SET reserved_usd=0 WHERE id=$1",
    [f.base.pool_id],
  );
  await getPool().query(
    "UPDATE compute_funding_grants SET reserved_usd=0 WHERE id=$1",
    [f.grant.id],
  );
  mockReceiptHomes.set(f.payer, "another-authority");
  await finalizeSettledCourseFundingPools();
  expect((await f.pool()).state).toBe("closing");
  expect((await f.backing()).prepaid_held_usd).toBe("20.0000000000");
  mockReceiptHomes.delete(f.payer);
  await finalizeSettledCourseFundingPools();
  expect((await f.pool()).state).toBe("closed");
  expect((await f.backing()).prepaid_held_usd).toBe("0.0000000000");
  await finalizeSettledCourseFundingPools();
  expect((await f.pool()).state).toBe("closed");
});
