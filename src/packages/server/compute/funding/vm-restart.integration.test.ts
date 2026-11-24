/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type {
  ComputeVmFundingBinding,
  ReserveComputeVmFundingRequest,
} from "@cocalc/util/compute-vm-funding";
import { getComputeVmById } from "../db";
import { requestScheduledVmState } from "../scheduled-stop";
import { withFundingAccountTransaction } from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import {
  reserveComputeVmFundingLocal,
  checkComputeVmFundingLocal,
} from "./vm-reservations";
import * as vmFunding from "./vm-funding";
import { courseVmBinding, meterCourseVm, payerApi } from "./vm-funding";
import { settleComputeVmFundingLocal } from "./vm-settlement";
import { prepareCourseVmRestart } from "./vm-restart";
import { restartClock } from "./restart-clock";
import * as exposure from "./exposure";
import { fundingResourceFixtures } from "./__tests__/resource-fixtures";
import { enableTestSponsorshipRollout } from "./__tests__/rollout-fixture";

jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ compute_vm_course_funding_enabled: true }),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({
    home_bay_id: require("@cocalc/server/bay-config").getConfiguredBayId(),
  }),
}));

// PGlite has one connection, so a paused transaction cannot overlap another.
const postgresIt = process.env.COCALC_TEST_USE_PGLITE === "1" ? it.skip : it;
const deployment = process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
let stopRollout: (() => void) | undefined;
beforeAll(async () => {
  process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "restart-replace-test";
  await before({ noConat: true });
  stopRollout = await enableTestSponsorshipRollout();
}, 60_000);
const fixtures = fundingResourceFixtures();
afterEach(async () => {
  jest.restoreAllMocks();
  await fixtures.cleanup();
});
afterAll(async () => {
  try {
    await fixtures.cleanup();
  } finally {
    stopRollout?.();
    await after();
    if (deployment == null) delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
    else process.env.COCALC_COMPUTE_DEPLOYMENT_ID = deployment;
  }
});

/** A stopped course VM at generation 1 whose run was metered and settled. */
async function stoppedCourseVm() {
  const payer = randomUUID(),
    student = randomUUID(),
    vmId = randomUUID(),
    epoch = randomUUID();
  fixtures.add(payer, student);
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1),($2)", [
    payer,
    student,
  ]);
  await getPool().query(
    "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,-100,'credit',NOW())",
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
        amount_usd: "50",
        allow_overcommit: false,
        starts_at: new Date(Date.now() - 1000).toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        recipients: [{ beneficiary_account_id: student, amount_usd: "50" }],
      },
    }),
  );
  const source = {
    kind: "course" as const,
    pool_id: allocation.pool.id,
    grant_id: allocation.grants[0].id,
    payer_account_id: payer,
  };
  const binding = await reserveComputeVmFundingLocal({
    account_id: payer,
    source,
    resource_id: vmId,
    resource_generation: 1,
    funding_epoch: epoch,
    owner_account_id: student,
    owning_bay_id: getConfiguredBayId(),
    provider: "nebius",
    hourly_cost_usd: "6",
    storage_hourly_cost_usd: "0.01",
    pricing_snapshot: { provider: "nebius" },
    requested_until: new Date(Date.now() + 25 * 60_000).toISOString(),
  });
  await checkComputeVmFundingLocal({ account_id: payer, binding, dispatch: true });
  await getPool().query(
    "UPDATE compute_funding_reservations SET dispatched_at=NOW()-interval '1 minute' WHERE id=$1",
    [binding.reservation_id],
  );
  const rate = { hourly_cost_usd: "6", pricing_snapshot: { provider: "nebius" } };
  await getPool().query(
    `INSERT INTO compute_vms (id,owner_account_id,owning_bay_id,name,public_hostname,bootstrap_revision,funding_mode,state,desired_state,stop_generation,boot_disk_id,provider,instance_generation,metadata,effective_pricing_model,desired_pricing_model)
    VALUES ($1,$2,$3,'restart-test',$1::uuid::text || '.example',2,'account-prepaid','ready','running',1,'retained-disk','nebius',1,$4,'spot','spot')`,
    [
      vmId,
      student,
      getConfiguredBayId(),
      {
        billing: {
          course_funding: { source, funding_epoch: epoch, binding },
          running_rates: { spot: rate, on_demand: rate },
          stopped_rate: { hourly_cost_usd: "0.01" },
        },
      },
    ],
  );
  await getPool().query(
    "UPDATE compute_vms SET state='stopped',desired_state='stopped',stopped_at=NOW() WHERE id=$1",
    [vmId],
  );
  // Settle the stopped run so its reservation is the 'settling' predecessor.
  await meterCourseVm((await getComputeVmById(vmId))!);
  return { payer, student, vmId, source, binding };
}

type Vm = Awaited<ReturnType<typeof stoppedCourseVm>>;

function restartRequest(
  f: Vm,
  requested_until: Date,
): ReserveComputeVmFundingRequest {
  return {
    account_id: f.payer,
    source: f.source,
    resource_id: f.vmId,
    resource_generation: 2,
    owner_account_id: f.student,
    owning_bay_id: getConfiguredBayId(),
    funding_epoch: randomUUID(),
    provider: "nebius",
    hourly_cost_usd: "6",
    storage_hourly_cost_usd: "0.01",
    pricing_snapshot: { provider: "nebius" },
    requested_until: requested_until.toISOString(),
    previous_reservation_id: f.binding.reservation_id,
  };
}

async function storePending(
  vmId: string,
  operation_id: string,
  request: ReserveComputeVmFundingRequest,
) {
  await getPool().query(
    "UPDATE compute_vms SET metadata=jsonb_set(metadata,'{billing,course_funding,restart}',$2::jsonb) WHERE id=$1",
    [vmId, JSON.stringify({ operation_id, request })],
  );
}

/** Store a pending restart and return its request as read back (jsonb
 * reorders keys, and production reserves the stored copy). */
async function storeAndRead(
  vmId: string,
  operation_id: string,
  request: ReserveComputeVmFundingRequest,
): Promise<ReserveComputeVmFundingRequest> {
  await storePending(vmId, operation_id, request);
  return (await storedPending(vmId)).request;
}

async function storedPending(vmId: string) {
  return (await getComputeVmById(vmId))!.metadata.billing.course_funding
    .restart;
}

/** Make a committed, never-dispatched reservation look expired. */
async function expire(binding: ComputeVmFundingBinding) {
  const past = new Date(Date.now() - 65 * 60_000).toISOString();
  await getPool().query(
    `UPDATE compute_funding_reservations SET authorized_until=$2::timestamptz,
      pricing_snapshot=jsonb_set(jsonb_set(pricing_snapshot,'{binding,stop_at}',to_jsonb($2::text)),'{binding,authorized_until}',to_jsonb($2::text))
    WHERE id=$1`,
    [binding.reservation_id, past],
  );
  return { ...binding, stop_at: past, authorized_until: past };
}

async function reservation(id: string) {
  return (
    await getPool().query(
      "SELECT state,authorized_usd::text,spent_usd::text,released_usd::text,dispatched_at FROM compute_funding_reservations WHERE id=$1",
      [id],
    )
  ).rows[0];
}

async function reservedTotals(f: Vm) {
  const {
    rows: [row],
  } = await getPool().query(
    `SELECT (SELECT reserved_usd::text FROM compute_funding_pools WHERE id=$1) AS pool,
      (SELECT reserved_usd::text FROM compute_funding_grants WHERE id=$2) AS grant`,
    [f.source.pool_id, f.source.grant_id],
  );
  return { pool: Number(row.pool), grant: Number(row.grant) };
}

async function epochRows(payer: string, epoch: string) {
  return (
    await getPool().query(
      "SELECT count(*)::int AS n FROM compute_funding_reservations WHERE payer_account_id=$1 AND operation_id=$2",
      [payer, epoch],
    )
  ).rows[0].n;
}

/** payerApi with chosen operations replaced; the rest stay the local ones. */
async function stubPayer(
  payer: string,
  overrides: Partial<Awaited<ReturnType<typeof payerApi>>>,
) {
  const real = await payerApi(payer);
  const api = { ...real, ...overrides };
  jest.spyOn(vmFunding, "payerApi").mockResolvedValue(api);
  return real;
}

it("replaces a stale pending restart from another key that never reserved", async () => {
  const f = await stoppedCourseVm();
  const old = restartRequest(f, new Date(Date.now() - 2 * 3600_000));
  await storePending(f.vmId, randomUUID(), old);
  const vm = (await getComputeVmById(f.vmId))!;
  const prepared = await prepareCourseVmRestart(vm, randomUUID(), null);
  expect(prepared!.binding.resource_generation).toBe(2);
  expect(prepared!.binding.funding_epoch).not.toBe(old.funding_epoch);
  expect(new Date(prepared!.binding.stop_at).valueOf()).toBeGreaterThan(
    Date.now(),
  );
  expect((await storedPending(f.vmId)).request.funding_epoch).toBe(
    prepared!.binding.funding_epoch,
  );
  // The old request still cannot reserve: the quote refuses it.
  expect(await epochRows(f.payer, old.funding_epoch)).toBe(0);
  await expect(reserveComputeVmFundingLocal(old)).rejects.toThrow(
    "Funding must cover fifteen useful minutes plus the shutdown margin.",
  );
  expect(await epochRows(f.payer, old.funding_epoch)).toBe(0);
});

it("lets the same key retry after its authorization expired, releasing the old reservation first", async () => {
  const f = await stoppedCourseVm();
  const operation = randomUUID();
  const old = await storeAndRead(
    f.vmId,
    operation,
    restartRequest(f, new Date(Date.now() + 25 * 60_000)),
  );
  const oldBinding = await reserveComputeVmFundingLocal(old);
  await expire(oldBinding);
  const before = await reservedTotals(f);
  const authorized = Number((await reservation(oldBinding.reservation_id)).authorized_usd);
  const real = await payerApi(f.payer);
  const order: string[] = [];
  await stubPayer(f.payer, {
    settleComputeVmFunding: async (opts) => {
      const result = await real.settleComputeVmFunding(opts);
      // The confirmation is observed while the VM still holds the old request.
      order.push(`settle:${(await storedPending(f.vmId)).request.funding_epoch}`);
      return result;
    },
    reserveComputeVmFunding: async (opts) => {
      order.push(`reserve:${opts.funding_epoch}`);
      return await real.reserveComputeVmFunding(opts);
    },
  });
  const vm = (await getComputeVmById(f.vmId))!;
  const prepared = await prepareCourseVmRestart(vm, operation, null);
  expect(prepared!.binding.funding_epoch).not.toBe(old.funding_epoch);
  expect(order).toEqual([
    `settle:${old.funding_epoch}`,
    `reserve:${prepared!.binding.funding_epoch}`,
  ]);
  const released = await reservation(oldBinding.reservation_id);
  expect(released.state).toBe("settled");
  expect(Number(released.spent_usd)).toBe(0);
  expect(Number(released.released_usd)).toBe(authorized);
  const after = await reservedTotals(f);
  const added = Number(
    (await reservation(prepared!.binding.reservation_id)).authorized_usd,
  );
  expect(after.pool).toBeCloseTo(before.pool - authorized + added, 8);
  expect(after.grant).toBeCloseTo(before.grant - authorized + added, 8);
  const {
    rows: [event],
  } = await getPool().query(
    "SELECT count(*)::int AS n FROM compute_funding_events WHERE reservation_id=$1 AND kind='canceled-before-dispatch'",
    [oldBinding.reservation_id],
  );
  expect(event.n).toBe(1);
});

it("keeps a live pending restart from another key and releases nothing", async () => {
  const f = await stoppedCourseVm();
  const old = await storeAndRead(
    f.vmId,
    randomUUID(),
    restartRequest(f, new Date(Date.now() + 25 * 60_000)),
  );
  const oldBinding = await reserveComputeVmFundingLocal(old);
  const before = await reservedTotals(f);
  const vm = (await getComputeVmById(f.vmId))!;
  await expect(prepareCourseVmRestart(vm, randomUUID(), null)).rejects.toThrow(
    "Another sponsored restart is pending.",
  );
  expect((await reservation(oldBinding.reservation_id)).state).toBe("reserved");
  expect(await reservedTotals(f)).toEqual(before);
  expect((await storedPending(f.vmId)).request.funding_epoch).toBe(
    old.funding_epoch,
  );
});

it("refuses an old prepared restart after its replacement, at apply and at dispatch", async () => {
  const f = await stoppedCourseVm();
  const vm = (await getComputeVmById(f.vmId))!;
  const first = await prepareCourseVmRestart(vm, randomUUID(), null);
  await expire(first!.binding);
  const second = await prepareCourseVmRestart(
    (await getComputeVmById(f.vmId))!,
    randomUUID(),
    null,
  );
  expect(second!.binding.funding_epoch).not.toBe(first!.binding.funding_epoch);
  await expect(
    requestScheduledVmState({
      vm: (await getComputeVmById(f.vmId))!,
      desired_state: "running",
      actor_kind: "owner",
      idempotency_key: first!.operation_id,
      prepared_funding: first,
    }),
  ).rejects.toThrow("Sponsored restart resource generation changed.");
  await expect(
    checkComputeVmFundingLocal({
      account_id: f.payer,
      binding: first!.binding,
      dispatch: true,
    }),
  ).rejects.toThrow("VM service authorization has ended.");
  const vmAfter = (await getComputeVmById(f.vmId))!;
  expect(vmAfter.instance_generation).toBe(1);
  expect((await reservation(first!.binding.reservation_id)).dispatched_at).toBeNull();
});

it("releases only an expired, undispatched, unspent sponsored reservation", async () => {
  const f = await stoppedCourseVm();
  const live = await reserveComputeVmFundingLocal(
    restartRequest(f, new Date(Date.now() + 25 * 60_000)),
  );
  const before = await reservedTotals(f);
  const release = (binding: ComputeVmFundingBinding) =>
    settleComputeVmFundingLocal({
      account_id: f.payer,
      binding,
      running_until: binding.stop_at,
      release_undispatched: true,
    });
  const refused =
    "Only an expired, undispatched sponsored reservation can be released.";
  await expect(release(live)).rejects.toThrow(refused);
  const expired = await expire(live);
  await expect(
    settleComputeVmFundingLocal({
      account_id: f.payer,
      binding: expired,
      running_until: expired.stop_at,
      public_egress_bytes: 0,
      release_undispatched: true,
    }),
  ).rejects.toThrow(refused);
  await getPool().query(
    "UPDATE compute_funding_reservations SET dispatched_at=NOW(),state='dispatched' WHERE id=$1",
    [live.reservation_id],
  );
  await expect(release(expired)).rejects.toThrow(refused);
  await getPool().query(
    "UPDATE compute_funding_reservations SET dispatched_at=NULL,state='reserved',spent_usd=0.01 WHERE id=$1",
    [live.reservation_id],
  );
  await expect(release(expired)).rejects.toThrow(refused);
  await getPool().query(
    "UPDATE compute_funding_reservations SET spent_usd=0 WHERE id=$1",
    [live.reservation_id],
  );
  expect(await reservedTotals(f)).toEqual(before);
  const first = await release(expired);
  expect(first.released_undispatched).toBe(true);
  expect(Number(first.committed_usd)).toBe(0);
  const once = await reservedTotals(f);
  // Repeating the release changes nothing.
  const again = await release(expired);
  expect(again.released_undispatched).toBe(true);
  expect(await reservedTotals(f)).toEqual(once);
});

it("fails closed when the payer does not confirm the release (older payer)", async () => {
  const f = await stoppedCourseVm();
  const operation = randomUUID();
  const old = await storeAndRead(
    f.vmId,
    operation,
    restartRequest(f, new Date(Date.now() + 25 * 60_000)),
  );
  const oldBinding = await reserveComputeVmFundingLocal(old);
  await expire(oldBinding);
  const reserve = jest.fn();
  await stubPayer(f.payer, {
    settleComputeVmFunding: async () => ({
      charged_usd: "0.0000000000",
      authorized_usd: oldBinding.authorized_usd,
      committed_usd: oldBinding.authorized_usd,
      overrun: false,
    }),
    reserveComputeVmFunding: reserve,
  });
  const stored = JSON.stringify(await storedPending(f.vmId));
  await expect(
    prepareCourseVmRestart((await getComputeVmById(f.vmId))!, operation, null),
  ).rejects.toThrow(
    "The expired restart authorization could not be released yet; try again later.",
  );
  expect(JSON.stringify(await storedPending(f.vmId))).toBe(stored);
  expect(reserve).not.toHaveBeenCalled();
  expect((await reservation(oldBinding.reservation_id)).state).toBe("reserved");
});

it("treats a recent pending restart without a reservation as in flight", async () => {
  const f = await stoppedCourseVm();
  const operation = randomUUID();
  const old = restartRequest(f, new Date(Date.now() + 22 * 60_000));
  await storePending(f.vmId, operation, old);
  await expect(
    prepareCourseVmRestart((await getComputeVmById(f.vmId))!, randomUUID(), null),
  ).rejects.toThrow("Another sponsored restart is pending.");
  expect((await storedPending(f.vmId)).request.funding_epoch).toBe(
    old.funding_epoch,
  );
  // The same key is the retry of that reserve.
  const prepared = await prepareCourseVmRestart(
    (await getComputeVmById(f.vmId))!,
    operation,
    null,
  );
  expect(prepared!.binding.funding_epoch).toBe(old.funding_epoch);
});

it("never treats a failed lookup or a non-time barrier failure as absence", async () => {
  const f = await stoppedCourseVm();
  const old = restartRequest(f, new Date(Date.now() - 2 * 3600_000));
  await storePending(f.vmId, randomUUID(), old);
  const stored = JSON.stringify(await storedPending(f.vmId));
  await stubPayer(f.payer, {
    lookupComputeVmFunding: async () => {
      throw Error("payer bay unreachable");
    },
  });
  await expect(
    prepareCourseVmRestart((await getComputeVmById(f.vmId))!, randomUUID(), null),
  ).rejects.toThrow("payer bay unreachable");
  expect(JSON.stringify(await storedPending(f.vmId))).toBe(stored);
  jest.restoreAllMocks();
  await stubPayer(f.payer, {
    reserveComputeVmFunding: async () => {
      throw Error("Billing is restricted for this funding account.");
    },
  });
  await expect(
    prepareCourseVmRestart((await getComputeVmById(f.vmId))!, randomUUID(), null),
  ).rejects.toThrow("Billing is restricted for this funding account.");
  expect(JSON.stringify(await storedPending(f.vmId))).toBe(stored);
});

it("returns the same binding when the same key retries after a replacement", async () => {
  const f = await stoppedCourseVm();
  await storePending(
    f.vmId,
    randomUUID(),
    restartRequest(f, new Date(Date.now() - 2 * 3600_000)),
  );
  const operation = randomUUID();
  const first = await prepareCourseVmRestart(
    (await getComputeVmById(f.vmId))!,
    operation,
    null,
  );
  const retry = await prepareCourseVmRestart(
    (await getComputeVmById(f.vmId))!,
    operation,
    null,
  );
  expect(retry!.binding.reservation_id).toBe(first!.binding.reservation_id);
  expect(await epochRows(f.payer, first!.binding.funding_epoch)).toBe(1);
});

it("recognises a billing-authority payer's deadline refusal and nothing looser", async () => {
  const f = await stoppedCourseVm();
  const real = await payerApi(f.payer);
  let pendingEpoch = "";
  const refusal =
    (message: string) => async (opts: ReserveComputeVmFundingRequest) => {
      if (opts.funding_epoch === pendingEpoch) throw Error(message);
      return await real.reserveComputeVmFunding(opts);
    };
  // A wrapped message that is not one of the quote's refusals: fail closed.
  pendingEpoch = (
    await storeAndRead(
      f.vmId,
      randomUUID(),
      restartRequest(f, new Date(Date.now() - 2 * 3600_000)),
    )
  ).funding_epoch;
  const stored = JSON.stringify(await storedPending(f.vmId));
  await stubPayer(f.payer, {
    reserveComputeVmFunding: refusal(
      "Funding must cover fifteen useful minutes plus the shutdown margin, almost [billing authority command c; status failed]",
    ),
  });
  await expect(
    prepareCourseVmRestart((await getComputeVmById(f.vmId))!, randomUUID(), null),
  ).rejects.toThrow("almost");
  expect(JSON.stringify(await storedPending(f.vmId))).toBe(stored);
  jest.restoreAllMocks();
  // The billing-authority form of a real refusal: positive absence.
  await stubPayer(f.payer, {
    reserveComputeVmFunding: refusal(
      "Funding must cover fifteen useful minutes plus the shutdown margin. [billing authority command c; status failed]",
    ),
  });
  const prepared = await prepareCourseVmRestart(
    (await getComputeVmById(f.vmId))!,
    randomUUID(),
    null,
  );
  expect(prepared!.binding.funding_epoch).not.toBe(pendingEpoch);
});

postgresIt(
  "waits for an in-flight reserve of the old request instead of orphaning it",
  async () => {
    const f = await stoppedCourseVm();
    const old = await storeAndRead(
      f.vmId,
      randomUUID(),
      restartRequest(f, new Date(Date.now() + 25 * 60_000)),
    );
    // The race the barrier exists for: the lookup ran before the old reserve
    // took the payer's locks, so it saw nothing; the old reserve then holds
    // those locks (paused after its quote) when the barrier arrives.
    let resume!: () => void;
    const paused = new Promise<void>((r) => (resume = r));
    let reached!: () => void;
    const atPause = new Promise<void>((r) => (reached = r));
    const realCheck = exposure.assertFundingExposureAvailable;
    jest
      .spyOn(exposure, "assertFundingExposureAvailable")
      .mockImplementationOnce(async (...args) => {
        reached();
        await paused;
        return await realCheck(...args);
      });
    const inFlight = reserveComputeVmFundingLocal(old);
    let prepare: Promise<unknown> | undefined;
    try {
      await atPause;
      const vm = (await getComputeVmById(f.vmId))!;
      jest.spyOn(vmFunding, "meterCourseVm").mockResolvedValue(vm);
      const real = await payerApi(f.payer);
      const reserved: string[] = [];
      await stubPayer(f.payer, {
        lookupComputeVmFunding: async () => null,
        reserveComputeVmFunding: async (opts) => {
          reserved.push(opts.funding_epoch);
          return await real.reserveComputeVmFunding(opts);
        },
      });
      // Age the stored request on the bay's clock only; the payer's clock
      // and its admission proofs are untouched.
      const later = Date.now() + 35 * 60_000;
      jest.spyOn(restartClock, "now").mockReturnValue(later);
      let settled = false;
      prepare = prepareCourseVmRestart(vm, randomUUID(), null);
      prepare.then(
        () => (settled = true),
        () => (settled = true),
      );
      await delay(1000);
      expect(reserved).toEqual([old.funding_epoch]);
      expect(settled).toBe(false);
      resume();
      const committed = await inFlight;
      await expect(prepare).rejects.toThrow(
        "Only an expired, undispatched sponsored reservation can be released.",
      );
      // The barrier returned the committed row and the payer refused to
      // release a live one: no CAS, no new reservation, nothing orphaned.
      expect(reserved).toEqual([old.funding_epoch]);
      expect((await storedPending(f.vmId)).request.funding_epoch).toBe(
        committed.funding_epoch,
      );
      expect((await reservation(committed.reservation_id)).state).toBe(
        "reserved",
      );
      const {
        rows: [count],
      } = await getPool().query(
        "SELECT count(*)::int AS n FROM compute_funding_reservations WHERE resource_id=$1 AND resource_generation=2",
        [f.vmId],
      );
      expect(count.n).toBe(1);
    } finally {
      resume();
      await Promise.allSettled([inFlight, prepare ?? Promise.resolve()]);
    }
  },
  30_000,
);
