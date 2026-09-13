/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { getLogger } from "@cocalc/backend/logger";
import { client as fabric } from "@cocalc/server/test";
import { createServiceHandler } from "@cocalc/conat/service/typed";
import {
  accountLocalSubject,
  directorySubject,
  createInterBayAccountLocalClient,
  createInterBayProjectReferenceHandler,
} from "@cocalc/conat/inter-bay/api";
import { resolveProjectBayDirect } from "@cocalc/server/inter-bay/directory";
import { handleProjectReferenceGet } from "@cocalc/server/inter-bay/project-control";
import {
  acceptAccountRehome,
  copyAccountRehomeState,
  getAccountRehomeOperation,
  rehomeAccountOnHomeBay,
} from "@cocalc/server/accounts/rehome";
import { activateAccountFinancialState } from "@cocalc/server/accounts/financial-rehome";
import { ensureCourseCreditNoticeSchema } from "@cocalc/server/notifications/course-credit-state";
import { receiveComputeResourceNotice } from "@cocalc/server/notifications/compute-resource";
import type { ComputeResourceNotice } from "@cocalc/util/compute-notifications";
import type { PersonalResourceReviewRequest } from "@cocalc/util/compute-personal-funding-review";
import { reviewPersonalResourceOnBay } from "./resource-review";
import { expirePersonalFundingConsents } from "./personal-expiry";
import { canonicalFundingTerms } from "./approvals";
import { processPersonalVmHandoffOnBay } from "./vm-personal-remote-resource";
import { getComputeVmFallbackDecisionLocal } from "./vm-fallback-reason";
import {
  applyRemotePersonalVolumeHandoff,
  processRemotePersonalVolumeHandoffs,
} from "./volume-personal-remote";
import {
  approvePersonalVolumeFunding,
  reviewPersonalVolumeFunding,
  switchVolumePersonalFunding,
  getVolumePersonalFunding,
  clearVolumePersonalFunding,
} from "./volume-personal";
import getSpendableBalance, {
  getAccountFundingHolds,
} from "@cocalc/server/purchases/get-spendable-balance";
import { lockAccountSpending } from "@cocalc/server/purchases/lock-account-spending";
import createCredit from "@cocalc/server/purchases/create-credit";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type { ReserveComputeVmFundingRequest } from "@cocalc/util/compute-vm-funding";
import type { VmPersonalFundingTerms } from "@cocalc/util/compute-vm-funding";
import { getComputeVmById, updateComputeInstance } from "../db";
import { getComputeVolumeById } from "../volume-db";
import {
  reserveCourseVolume,
  requireCourseVolumeService,
  courseVolumeBinding,
  meterCourseVolume,
} from "./volume-funding";
import {
  switchVmPersonalFunding,
  processVmPersonalFundingHandoffs,
  getVmPersonalFunding,
  clearVmPersonalFunding,
  previewPersonalVmFunding,
  reviewPersonalVmFundingOnBay,
} from "./vm-personal";
import { withFundingAccountTransaction } from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import { assertCourseAccess } from "./course-access";
import {
  reserveComputeVmFundingLocal,
  checkComputeVmFundingLocal,
} from "./vm-reservations";
import { lookupComputeVmFundingLocal } from "./vm-lookup";
import { settleComputeVmFundingLocal } from "./vm-settlement";
import {
  meterCourseVm,
  payerApi,
  reserveCourseVmLaunch,
  requireCourseVmService,
} from "./vm-funding";
import { recoverExistingCourseVmFunding } from "./vm-worker-recovery";
import {
  prepareCourseVmRestart,
  applyPreparedCourseRestart,
} from "./vm-restart";
import { setPolicy } from "./__tests__/policy-source";
import {
  bays,
  pools,
  onBay,
  independentBayDatabases,
} from "./__tests__/multibay-postgres";

jest.mock("@cocalc/database/pool", () =>
  require("./__tests__/multibay-postgres").poolModule(),
);

// Explicit environment hooks: directory STORAGE and membership/payment evidence.
// resolveAccountHomeBay, payerApi, project routing/access, SQL and locks are real.
const mockHomes = new Map<string, string>();
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: async (account_id) =>
    mockHomes.has(account_id)
      ? { account_id, home_bay_id: mockHomes.get(account_id) }
      : undefined,
  updateClusterAccountHomeBay: async ({ account_id, home_bay_id }) => {
    mockHomes.set(account_id, home_bay_id);
  },
  updateClusterAccountApiKeysHomeBay: async () => {},
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  ...jest.requireActual("@cocalc/server/cluster-config"),
  isMultiBayCluster: () => true,
}));
jest.mock("@cocalc/server/bay-registry", () => {
  const list = async () =>
    require("./__tests__/multibay-postgres").bays.map((bay_id) => ({ bay_id }));
  return {
    listClusterBayRegistry: list,
    listClusterBayInfos: list,
    listAuthoritativeClusterBayInfos: list,
  };
});
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => require("@cocalc/server/test").client,
}));
jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ compute_vm_course_funding_enabled: true }),
}));

// Explicit attestation hook, NOT signed-rollout acceptance. The real exposure
// loader validates this allocation and the real SQL pins/enforces each quota.
jest.mock("./production-rollout-manifest", () => ({
  loadProductionFundingRollout: async () => ({
    manifest: {
      bays: require("./__tests__/multibay-postgres").bays.map((bay_id) => ({
        bay_id,
      })),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      exposure_allocation: {
        id: "sponsorship-test-static-allocation",
        // Cases retain separate accounts and reservations for replay assertions.
        // Dedicated exposure tests exercise small quotas and their exhaustion.
        site_ceiling_usd: "1000",
        bay_quotas: require("./__tests__/multibay-postgres").bays.map(
          (bay_id) => ({ bay_id, amount_usd: "300" }),
        ),
      },
    },
  }),
}));
jest.mock("./rollout", () => ({
  assertSponsorshipAdmission: async () => ({ expires_at: Date.now() + 30000 }),
  assertSponsorshipAdmissionInTransaction: async () => {},
}));

// Financial rehome is real; this suite has no account files or browser sessions.
jest.mock("@cocalc/server/accounts/persist-portability", () => ({
  loadAccountPersistState: async () => [],
  restoreAccountPersistState: async () => {},
  clearAccountPersistState: async () => {},
}));
jest.mock("@cocalc/server/conat/api/browser-sessions", () => ({
  listBrowserSessionsForAccount: async () => [],
}));

const [payerBay, resourceBay, courseBay] = bays;
const describePg =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe.skip : describe;
describePg(
  "VM sponsorship with three independent PostgreSQL bays and Conat",
  () => {
    const databases = independentBayDatabases();
    const originalExposure = process.env.COCALC_COURSE_VM_SITE_EXPOSURE_USD;
    const handlers: ReturnType<typeof createServiceHandler>[] = [];
    const calls: { bay: string; method: string }[] = [];
    let loseReserve = false;
    let loseSettlement = false;
    let losePersonalVolumeReceipt = false;
    let changeVolumeBeforeCommit: string | undefined;
    let dropPersonalVolumeCommand = false;
    let loseVmHandoffReceipt = false;
    let invalidateVmBeforeCommit = false;
    let cancelVmBeforeCommit = false;
    const remote = (bay: string) =>
      createInterBayAccountLocalClient({
        client: fabric,
        dest_bay: bay,
        timeout: 5000,
      });

    beforeAll(async () => {
      process.env.COCALC_COURSE_VM_SITE_EXPOSURE_USD = "1000";
      await databases.start();
      handlers.push(
        createServiceHandler({
          client: fabric,
          service: "inter-bay-directory",
          subject: directorySubject({ method: "resolve-project-bay" }),
          impl: {
            resolveProjectBay: ({ project_id }) =>
              onBay(courseBay, () => resolveProjectBayDirect(project_id)),
          },
        }),
      );
      for (const bay of bays) {
        handlers.push(
          createInterBayProjectReferenceHandler({
            client: fabric,
            bay_id: bay,
            impl: {
              get: (opts) =>
                onBay(bay, async () => {
                  calls.push({ bay, method: "projectReference" });
                  return handleProjectReferenceGet(opts);
                }),
            },
          }),
        );
        handlers.push(
          createServiceHandler({
            client: fabric,
            service: "inter-bay-account-local",
            subject: accountLocalSubject({
              dest_bay: bay,
              method: "compute-funding",
            }),
            impl: {
              computeProjectResources: (opts) =>
                onBay(bay, async () =>
                  (
                    await import("../owner-resource-routing")
                  ).computeProjectResourcesOnBay(opts),
                ),
              computeOwnerMutate: (opts) =>
                onBay(bay, async () =>
                  (
                    await import("../owner-resource-mutation")
                  ).computeOwnerMutationOnBay(opts),
                ),
              computeOwnerCheckFreshAuth: (opts) =>
                onBay(bay, async () =>
                  (
                    await import("../owner-resource-mutation")
                  ).checkComputeOwnerFreshAuthOnHome(opts),
                ),
              computeOwnerResources: (opts) =>
                onBay(bay, async () =>
                  (
                    await import("../owner-resource-routing")
                  ).computeOwnerResourcesOnBay(opts),
                ),
              computeFundingPersonalVmHandoff: (opts) =>
                onBay(bay, async () => {
                  if (opts.phase === "commit" && invalidateVmBeforeCommit) {
                    invalidateVmBeforeCommit = false;
                    await (
                      await import("../scheduled-stop")
                    ).requestScheduledVmState({
                      vm: (await getComputeVmById(opts.terms.vm_id))!,
                      desired_state: "stopped",
                      actor_kind: "human",
                      idempotency_key: randomUUID(),
                    });
                  }
                  if (opts.phase === "commit" && cancelVmBeforeCommit) {
                    cancelVmBeforeCommit = false;
                    await onBay(mockHomes.get(opts.account_id)!, async () => {
                      const consent = (await getVmPersonalFunding({
                        account_id: opts.account_id,
                        vm_id: opts.terms.vm_id,
                      }))!;
                      await clearVmPersonalFunding({
                        account_id: opts.account_id,
                        vm_id: opts.terms.vm_id,
                        consent_id: opts.consent_id,
                        expected_version: consent.version,
                        operation_id: randomUUID(),
                      });
                    });
                  }
                  const result = await processPersonalVmHandoffOnBay(opts);
                  if (loseVmHandoffReceipt && result.state === "committed") {
                    loseVmHandoffReceipt = false;
                    throw Error("injected lost VM handoff receipt");
                  }
                  return result;
                }),
              computeFundingApplyPersonalVolumeHandoff: (opts) =>
                onBay(bay, async () => {
                  // The payer's reserve transaction must finish before this
                  // RPC. Exercise its real lock, not a mocked transaction flag.
                  await onBay(mockHomes.get(opts.account_id)!, async () => {
                    const db = await pools
                      .get(mockHomes.get(opts.account_id)!)!
                      .connect();
                    try {
                      await db.query("BEGIN");
                      await db.query("SET LOCAL lock_timeout='1s'");
                      await lockAccountSpending(db, opts.account_id);
                    } finally {
                      await db.query("ROLLBACK");
                      db.release();
                    }
                  });
                  if (dropPersonalVolumeCommand) {
                    dropPersonalVolumeCommand = false;
                    throw Error("injected lost personal volume commit receipt");
                  }
                  if (changeVolumeBeforeCommit) {
                    await pools
                      .get(bay)!
                      .query(
                        "UPDATE compute_volumes SET desired_size_gb=20 WHERE id=$1",
                        [changeVolumeBeforeCommit],
                      );
                    changeVolumeBeforeCommit = undefined;
                  }
                  const receipt = await applyRemotePersonalVolumeHandoff(opts);
                  if (losePersonalVolumeReceipt) {
                    losePersonalVolumeReceipt = false;
                    throw Error("injected lost personal volume commit receipt");
                  }
                  return receipt;
                }),
              computeFundingReviewPersonalResource: (
                opts: PersonalResourceReviewRequest,
              ) => onBay(bay, () => reviewPersonalResourceOnBay(opts)),
              computeFundingReceiveResourceNotice: (
                opts: ComputeResourceNotice,
              ) => onBay(bay, () => receiveComputeResourceNotice(opts)),
              getComputeVmFallbackDecision: (opts) =>
                onBay(bay, () => getComputeVmFallbackDecisionLocal(opts)),
              reserveComputeVmFunding: (opts: ReserveComputeVmFundingRequest) =>
                onBay(bay, async () => {
                  calls.push({ bay, method: "reserve" });
                  const binding = await reserveComputeVmFundingLocal(opts);
                  if (loseReserve) {
                    loseReserve = false;
                    throw Error("injected lost committed reserve reply");
                  }
                  return binding;
                }),
              lookupComputeVmFunding: (opts) =>
                onBay(bay, async () => {
                  calls.push({ bay, method: "lookup" });
                  return lookupComputeVmFundingLocal(opts);
                }),
              checkComputeVmFunding: (opts) =>
                onBay(bay, async () => {
                  calls.push({ bay, method: "check" });
                  return checkComputeVmFundingLocal(opts);
                }),
              settleComputeVmFunding: (opts) =>
                onBay(bay, async () => {
                  calls.push({ bay, method: "settle" });
                  const result = await settleComputeVmFundingLocal(opts);
                  if (loseSettlement) {
                    loseSettlement = false;
                    throw Error("injected lost committed settlement reply");
                  }
                  return result;
                }),
            },
          }),
        );
        for (const [method, impl] of Object.entries({
          "accept-rehome": {
            acceptRehome: (opts) => onBay(bay, () => acceptAccountRehome(opts)),
          },
          "copy-rehome-state": {
            copyRehomeState: (opts) =>
              onBay(bay, () => copyAccountRehomeState(opts)),
          },
          "get-rehome-operation": {
            getRehomeOperation: (opts) =>
              onBay(bay, () => getAccountRehomeOperation(opts.op_id)),
          },
          "activate-financial-rehome": {
            activateFinancialRehome: (opts) =>
              onBay(bay, () => activateAccountFinancialState(opts)),
          },
        }))
          handlers.push(
            createServiceHandler({
              client: fabric,
              service: "inter-bay-account-local",
              subject: `bay.${bay}.rpc.account-local.${method}`,
              impl,
            }),
          );
      }
    }, 60000);
    afterAll(async () => {
      for (const handler of handlers) handler.close();
      await databases.stop();
      if (originalExposure == null)
        delete process.env.COCALC_COURSE_VM_SITE_EXPOSURE_USD;
      else process.env.COCALC_COURSE_VM_SITE_EXPOSURE_USD = originalExposure;
    }, 60000);
    beforeEach(() => {
      calls.length = 0;
      loseReserve = false;
      loseSettlement = false;
      losePersonalVolumeReceipt = false;
      changeVolumeBeforeCommit = undefined;
      dropPersonalVolumeCommand = false;
      loseVmHandoffReceipt = false;
      invalidateVmBeforeCommit = false;
      cancelVmBeforeCommit = false;
    });

    async function fixture(
      amount = "20",
      lane: "prepaid" | "postpaid" = "prepaid",
    ) {
      const payer = randomUUID(),
        student = randomUUID(),
        project = randomUUID();
      for (const [id, bay] of [
        [payer, payerBay],
        [student, resourceBay],
      ]) {
        await pools
          .get(bay)!
          .query("INSERT INTO accounts(account_id,home_bay_id) VALUES($1,$2)", [
            id,
            bay,
          ]);
        mockHomes.set(id, bay);
      }
      await pools
        .get(courseBay)!
        .query(
          "INSERT INTO projects(project_id,owning_bay_id,users) VALUES($1,$2,$3)",
          [project, courseBay, { [payer]: { group: "owner" } }],
        );
      // QA ledger fixture, not transferable payment provenance or a Stripe payment.
      await pools
        .get(payerBay)!
        .query(
          "INSERT INTO purchases(account_id,cost,service,time) VALUES($1,-100,'credit',now())",
          [payer],
        );
      setPolicy(student, {
        has_active_second_factor: false,
        has_payment_method: false,
        can_create_hosts: false,
      });
      const allocation = await onBay(payerBay, async () => {
        await assertCourseAccess(payer, project);
        // Explicit already-approved allocation boundary. Isolated browser approval
        // is covered separately; this test never exposes a new mutation RPC.
        return withFundingAccountTransaction(payer, (db) =>
          createCourseFundingPoolInTransaction(db, {
            payer_account_id: payer,
            operation_id: randomUUID(),
            terms: {
              course_project_id: project,
              course_instance_id: randomUUID(),
              currency: "USD",
              lane,
              amount_usd: amount,
              allow_overcommit: false,
              starts_at: new Date(Date.now() - 1000).toISOString(),
              ends_at: new Date(Date.now() + 86400000).toISOString(),
              recipients: [
                { beneficiary_account_id: student, amount_usd: amount },
              ],
            },
          }),
        );
      });
      const request: ReserveComputeVmFundingRequest = {
        account_id: payer,
        source: {
          kind: "course",
          payer_account_id: payer,
          pool_id: allocation.pool.id,
          grant_id: allocation.grants[0].id,
        },
        resource_id: randomUUID(),
        resource_generation: 1,
        funding_epoch: randomUUID(),
        owner_account_id: student,
        owning_bay_id: resourceBay,
        provider: "nebius",
        hourly_cost_usd: "6",
        storage_hourly_cost_usd: "0.01",
        pricing_snapshot: { provider: "nebius" },
        requested_until: new Date(Date.now() + 25 * 60000).toISOString(),
      };
      await pools.get(resourceBay)!.query(
        `INSERT INTO compute_vms
      (id,name,owner_account_id,owning_bay_id,provider,instance_generation,state,desired_state,metadata,effective_pricing_model,created_at)
      VALUES($1,'Student VM',$2,$3,'nebius',1,'requested','running',$4,'spot',now())`,
        [
          request.resource_id,
          student,
          resourceBay,
          {
            billing: {
              course_funding: {
                source: request.source,
                funding_epoch: request.funding_epoch,
              },
              running_rates: {
                spot: {
                  hourly_cost_usd: "6",
                  pricing_snapshot: request.pricing_snapshot,
                },
              },
              stopped_rate: { hourly_cost_usd: "0.01" },
            },
          },
        ],
      );
      const vm = await onBay(resourceBay, () =>
        getComputeVmById(request.resource_id),
      );
      return { payer, student, project, request, allocation, vm: vm! };
    }

    async function row(bay: string, sql: string, params: unknown[] = []) {
      return (await pools.get(bay)!.query(sql, params)).rows[0];
    }

    async function approvedMovedVm(
      activation: "immediate" | "fallback" = "immediate",
      provider: "gcp" | "nebius" = "nebius",
    ) {
      const f = await fixture();
      const consentId = randomUUID();
      setPolicy(f.student, {});
      await pools
        .get(resourceBay)!
        .query(
          "INSERT INTO purchases(account_id,cost,service,time) VALUES($1,-10,'credit',NOW())",
          [f.student],
        );
      await onBay(resourceBay, async () => {
        await pools
          .get(resourceBay)!
          .query(
            "UPDATE compute_vms SET provider=$2,state='ready',stop_generation=1 WHERE id=$1",
            [f.vm.id, provider],
          );
        const vm = await reserveCourseVmLaunch(
          (await getComputeVmById(f.vm.id))!,
        );
        await requireCourseVmService(vm, true);
        const terms: VmPersonalFundingTerms = {
          vm_id: vm.id,
          expected_funding_version: f.request.funding_epoch,
          home_volume_ids: [],
          lane: "prepaid",
          cap_usd: "10",
          ends_at: new Date(Date.now() + 3600_000).toISOString(),
          activation,
          fallback_reasons: activation === "fallback" ? ["course_expired"] : [],
        };
        const review = await reviewPersonalVmFundingOnBay(f.student, terms);
        expect(() => canonicalFundingTerms(review)).not.toThrow();
        await pools.get(resourceBay)!.query(
          `INSERT INTO compute_vm_personal_consents (id,payer_account_id,vm_id,operation_id,terms,review,state,version,approval_url,approval_expires_at)
           VALUES($1,$2,$3,$4,$5,$6,'approved',2,'https://approval.example/test',NOW()+interval '15 minutes')`,
          [consentId, f.student, vm.id, randomUUID(), terms, review],
        );
        await ensureCourseCreditNoticeSchema();
        await rehomeAccountOnHomeBay({
          account_id: f.student,
          target_account_id: f.student,
          dest_bay_id: courseBay,
        });
      });
      return {
        ...f,
        consentId,
        switch: {
          account_id: f.student,
          vm_id: f.vm.id,
          consent_id: consentId,
          expected_version: 2,
          expected_funding_version: f.request.funding_epoch,
          operation_id: randomUUID(),
        },
      };
    }

    it.each(["owner-stop", "withdraw-consent"])(
      "does not restart a remote VM after %s wins the handoff race",
      async (cause) => {
        const f = await approvedMovedVm();
        await onBay(courseBay, () => switchVmPersonalFunding(f.switch));
        await pools
          .get(resourceBay)!
          .query(
            "UPDATE compute_vms SET state='stopped',stopped_at=clock_timestamp() WHERE id=$1",
            [f.vm.id],
          );
        invalidateVmBeforeCommit = cause === "owner-stop";
        cancelVmBeforeCommit = cause === "withdraw-consent";
        await onBay(courseBay, () => processVmPersonalFundingHandoffs());
        await onBay(courseBay, () => processVmPersonalFundingHandoffs());
        const consent = (await onBay(courseBay, () =>
          getVmPersonalFunding({ account_id: f.student, vm_id: f.vm.id }),
        ))!;
        expect(consent.state).toBe(
          cause === "owner-stop" ? "rejected" : "cancelled",
        );
        expect(toDecimal(consent.committed_usd).eq(0)).toBe(true);
        expect(toDecimal(consent.spent_usd).eq(0)).toBe(true);
        const vm = await onBay(resourceBay, () => getComputeVmById(f.vm.id));
        expect(vm!.instance_generation).toBe(1);
        expect(vm!.desired_state).toBe("stopped");
        const handoff = (
          await row(
            courseBay,
            "SELECT handoff FROM compute_vm_personal_consents WHERE id=$1",
            [f.consentId],
          )
        ).handoff.remote_vm;
        const replay = await remote(
          resourceBay,
        ).computeFundingPersonalVmHandoff({
          ...handoff.identity,
          phase: "commit",
          binding: handoff.binding,
        });
        expect(replay.state).toBe("aborted");
        expect(
          await row(
            resourceBay,
            "SELECT count(*)::int AS n FROM compute_resource_work WHERE resource_id=$1 AND action='start'",
            [f.vm.id],
          ),
        ).toEqual({ n: 0 });
      },
    );

    it("lists and opens the student's existing VM through the public API after account rehome", async () => {
      const f = await approvedMovedVm();
      await pools
        .get(resourceBay)!
        .query(
          "UPDATE compute_vms SET public_hostname='student-vm.example',bootstrap_revision=1,funding_mode='account-prepaid' WHERE id=$1",
          [f.vm.id],
        );
      const api = await import("@cocalc/server/conat/api/compute");
      await pools
        .get(resourceBay)!
        .query("UPDATE compute_vms SET project_id=$2 WHERE id=$1", [
          f.vm.id,
          f.project,
        ]);
      await onBay(courseBay, async () => {
        await expect(
          api.listProjectVms({ account_id: f.student, project_id: f.project }),
        ).rejects.toThrow(/access|not found/);
        await pools
          .get(courseBay)!
          .query(
            "UPDATE projects SET users=users || jsonb_build_object($2::text,jsonb_build_object('group','collaborator')) WHERE project_id=$1",
            [f.project, f.student],
          );
        expect(
          (
            await api.listProjectVms({
              account_id: f.student,
              project_id: f.project,
            })
          ).map((v) => v.id),
        ).toEqual([f.vm.id]);
        expect(
          (
            await api.getProjectVm({
              account_id: f.student,
              project_id: f.project,
              id_or_name: f.vm.id,
            })
          ).id,
        ).toBe(f.vm.id);
        await pools
          .get(resourceBay)!
          .query(
            "INSERT INTO compute_vm_project_access(vm_id,project_id,owner_account_id,owning_bay_id,revoked_at) VALUES($1,$2,$3,$4,NOW())",
            [f.vm.id, f.project, f.student, resourceBay],
          );
        expect(
          await api.listProjectVms({
            account_id: f.student,
            project_id: f.project,
          }),
        ).toEqual([]);
        await expect(
          api.getProjectVm({
            account_id: f.student,
            project_id: f.project,
            id_or_name: f.vm.id,
          }),
        ).rejects.toThrow(/access|not found/);
        const vms = await api.listVms({ account_id: f.student });
        expect(vms.map((v) => v.id)).toEqual([f.vm.id]);
        const vm = await api.getVm({
          account_id: f.student,
          id_or_name: f.vm.id,
        });
        expect(vm.owning_bay_id).toBe(resourceBay);
        expect(vm.funding_status?.personal_consent?.id).toBe(f.consentId);
        const stopped = await api.stopVm({
          account_id: f.student,
          id_or_name: f.vm.id,
          idempotency_key: randomUUID(),
        });
        expect(stopped.desired_state).toBe("stopped");
        expect(stopped.stop_generation).toBe(2);
        await expect(
          api.deleteVm({
            account_id: f.student,
            id_or_name: f.vm.id,
            idempotency_key: randomUUID(),
          }),
        ).rejects.toThrow(/fresh auth/);
        expect(
          (
            await pools
              .get(resourceBay)!
              .query("SELECT desired_state FROM compute_vms WHERE id=$1", [
                f.vm.id,
              ])
          ).rows[0].desired_state,
        ).toBe("stopped");
        const session_hash = randomUUID();
        const ssh_public_key = "ssh-ed25519 AAAAREHOMETEST rehome-test";
        await expect(
          api.authorizeSshKey({
            account_id: f.student,
            id_or_name: f.vm.id,
            ssh_public_key,
            idempotency_key: randomUUID(),
          }),
        ).rejects.toThrow(/fresh auth/);
        await (
          await import("@cocalc/server/auth/auth-sessions")
        ).recordNewAuthSession({
          account_id: f.student,
          session_hash,
          expire: new Date(Date.now() + 3600_000),
          fresh_auth_until: new Date(Date.now() + 60_000),
        });
        await api.authorizeSshKey({
          account_id: f.student,
          id_or_name: f.vm.id,
          session_hash,
          ssh_public_key,
          idempotency_key: randomUUID(),
        });
        expect(
          await api.listVmSshKeys({
            account_id: f.student,
            id_or_name: f.vm.id,
          }),
        ).toEqual(
          expect.arrayContaining([expect.objectContaining({ ssh_public_key })]),
        );
        const remainingKeys = await api.revokeSshKey({
          account_id: f.student,
          id_or_name: f.vm.id,
          ssh_public_key,
          idempotency_key: randomUUID(),
        });
        expect(
          remainingKeys.some((k) => k.ssh_public_key === ssh_public_key),
        ).toBe(false);
        await api.grantVmProjectAccess({
          account_id: f.student,
          id_or_name: f.vm.id,
          project_id: f.project,
          ssh_public_key,
          session_hash,
          idempotency_key: randomUUID(),
        });
        expect(
          await api.listVmProjectAccess({ account_id: f.student }),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ vm_id: f.vm.id, project_id: f.project }),
          ]),
        );
        await api.revokeVmProjectAccess({
          account_id: f.student,
          id_or_name: f.vm.id,
          project_id: f.project,
          idempotency_key: randomUUID(),
        });
        expect(
          await api.listVmProjectAccess({ account_id: f.student }),
        ).toEqual([
          expect.objectContaining({
            vm_id: f.vm.id,
            state: "revoking",
            revoked_at: expect.anything(),
          }),
        ]);
        expect(
          await api.listProjectVms({
            account_id: f.student,
            project_id: f.project,
          }),
        ).toEqual([]);
        const deleted = await api.deleteVm({
          account_id: f.student,
          id_or_name: f.vm.id,
          session_hash,
          idempotency_key: randomUUID(),
        });
        expect(deleted.desired_state).toBe("deleted");
        expect(
          await row(
            resourceBay,
            "SELECT count(*)::int AS n FROM compute_resource_work WHERE resource_id=$1 AND action='delete'",
            [f.vm.id],
          ),
        ).toEqual({ n: 1 });
        expect(await api.listVms({ account_id: randomUUID() })).toEqual([]);
        await expect(
          api.getVm({ account_id: randomUUID(), id_or_name: f.vm.id }),
        ).rejects.toThrow(/not found|access denied/);
      });
    });

    it("waits for the GCP network watermark on the resource bay before reserving personal funding", async () => {
      const f = await approvedMovedVm("immediate", "gcp");
      await onBay(courseBay, () => switchVmPersonalFunding(f.switch));
      await pools
        .get(resourceBay)!
        .query(
          "UPDATE compute_vms SET state='stopped',stopped_at=clock_timestamp() WHERE id=$1",
          [f.vm.id],
        );
      await onBay(courseBay, () => processVmPersonalFundingHandoffs());
      expect(
        await row(
          courseBay,
          "SELECT count(*)::int AS n FROM compute_funding_reservations WHERE payer_account_id=$1",
          [f.student],
        ),
      ).toEqual({ n: 0 });
      await pools
        .get(resourceBay)!
        .query(
          "UPDATE compute_vms SET metadata=jsonb_set(metadata,'{billing,egress}',jsonb_build_object('metered_through_at',stopped_at)) WHERE id=$1",
          [f.vm.id],
        );
      await onBay(courseBay, () => processVmPersonalFundingHandoffs());
      expect(
        (await onBay(courseBay, () =>
          getVmPersonalFunding({ account_id: f.student, vm_id: f.vm.id }),
        ))!.state,
      ).toBe("active");
      expect(
        (await onBay(resourceBay, () => getComputeVmById(f.vm.id)))!
          .instance_generation,
      ).toBe(2);
    });

    it.each([false, true])(
      "activates only approved remote expiry fallback, never suspension (suspended: %s)",
      async (suspended) => {
        const f = await approvedMovedVm("fallback");
        const past = new Date(Date.now() - 1_000).toISOString();
        await pools
          .get(payerBay)!
          .query(
            "UPDATE compute_funding_pools SET ends_at=$2,state=$3 WHERE id=$1",
            [f.allocation.pool.id, past, suspended ? "suspended" : "active"],
          );
        await pools
          .get(payerBay)!
          .query(
            "UPDATE compute_funding_reservations SET pricing_snapshot=jsonb_set(pricing_snapshot,'{binding,stop_at}',to_jsonb($2::text)) WHERE operation_id=$1",
            [f.request.funding_epoch, past],
          );
        await pools.get(resourceBay)!.query(
          `UPDATE compute_vms SET state='stopped',desired_state='stopped',stopped_at=clock_timestamp(),
          metadata=jsonb_set(jsonb_set(metadata,'{billing,course_funding,binding,stop_at}',to_jsonb($2::text)),
            '{billing,course_funding,stop_intent}',jsonb_build_object('stop_generation',stop_generation,'requested_at',clock_timestamp())) WHERE id=$1`,
          [f.vm.id, past],
        );
        await onBay(courseBay, () => processVmPersonalFundingHandoffs());
        const consent = (await onBay(courseBay, () =>
          getVmPersonalFunding({ account_id: f.student, vm_id: f.vm.id }),
        ))!;
        expect(consent.state).toBe(suspended ? "approved" : "active");
        expect(
          await row(
            courseBay,
            "SELECT count(*)::int AS n FROM compute_funding_reservations WHERE payer_account_id=$1",
            [f.student],
          ),
        ).toEqual({ n: suspended ? 0 : 1 });
      },
    );

    it("settles a sponsored restart without a VM row on the payer bay", async () => {
      const f = await fixture();
      await onBay(resourceBay, async () => {
        const bound = await reserveCourseVmLaunch(f.vm);
        await requireCourseVmService(bound, true);
        await pools
          .get(resourceBay)!
          .query(
            "UPDATE compute_vms SET state='stopped',desired_state='stopped',stopped_at=NOW() WHERE id=$1",
            [f.vm.id],
          );
        const vm = (await getComputeVmById(f.vm.id))!;
        const prepared = (await prepareCourseVmRestart(
          vm,
          randomUUID(),
          null,
        ))!;
        const db = await pools.get(resourceBay)!.connect();
        let restarted;
        try {
          await db.query("BEGIN");
          const {
            rows: [locked],
          } = await db.query(
            "SELECT * FROM compute_vms WHERE id=$1 FOR UPDATE",
            [vm.id],
          );
          restarted = await applyPreparedCourseRestart(db, locked, prepared);
          await db.query("COMMIT");
        } catch (err) {
          await db.query("ROLLBACK");
          throw err;
        } finally {
          db.release();
        }
        await (
          await payerApi(f.payer)
        ).checkComputeVmFunding({
          account_id: f.payer,
          binding: prepared.binding,
          dispatch: true,
        });
        await meterCourseVm(restarted!);
        await meterCourseVm(restarted!);
      });
      expect(
        await row(
          payerBay,
          "SELECT count(*)::int AS n FROM compute_vms WHERE id=$1",
          [f.vm.id],
        ),
      ).toEqual({ n: 0 });
      expect(
        await row(
          payerBay,
          "SELECT state FROM compute_funding_reservations WHERE operation_id=$1",
          [f.request.funding_epoch],
        ),
      ).toEqual({ state: "settled" });
    });

    it.each([
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ])(
      "hands approved personal funding from a remote instructor and retries lost settlement (home volume: %s, student moved: %s)",
      async (withHome, moved) => {
        const f = await fixture();
        const studentBay = moved ? courseBay : resourceBay;
        const consentId = randomUUID();
        setPolicy(f.student, {});
        await pools
          .get(resourceBay)!
          .query(
            "INSERT INTO purchases(account_id,cost,service,time) VALUES($1,-10,'credit',NOW())",
            [f.student],
          );
        await onBay(resourceBay, async () => {
          const bound = await reserveCourseVmLaunch(f.vm);
          await requireCourseVmService(bound, true);
          const volumeId = withHome ? randomUUID() : undefined;
          if (volumeId) {
            const epoch = randomUUID();
            await pools.get(resourceBay)!.query(
              `INSERT INTO compute_volumes (id,name,owner_account_id,owning_bay_id,provider,region,role,funding_mode,
            size_gb,desired_size_gb,effective_size_gb,state,desired_state,attachment_state,attached_vm_id,attachment_generation,created_at,metadata)
            VALUES ($1,'cross-bay-home',$2,$3,'nebius','eu-north1','home','account-prepaid',10,10,10,'ready','ready','attached',$4,1,NOW(),$5)`,
              [
                volumeId,
                f.student,
                resourceBay,
                f.vm.id,
                {
                  billing: {
                    rate: {
                      hourly_cost_usd: "0.01",
                      pricing_snapshot: { provider: "nebius" },
                    },
                    course_funding: {
                      source: {
                        ...f.request.source,
                        payer_account_id: f.payer,
                      },
                      funding_epoch: epoch,
                    },
                  },
                },
              ],
            );
            const volume = await reserveCourseVolume(
              (await getComputeVolumeById(volumeId))!,
            );
            await requireCourseVolumeService(volume, true);
            await pools
              .get(resourceBay)!
              .query(
                "UPDATE compute_volumes SET ready_at=clock_timestamp() WHERE id=$1",
                [volumeId],
              );
            await pools
              .get(resourceBay)!
              .query("UPDATE compute_vms SET home_volume_id=$2 WHERE id=$1", [
                f.vm.id,
                volumeId,
              ]);
          }
          await pools
            .get(resourceBay)!
            .query(
              "UPDATE compute_vms SET state='ready',stop_generation=1 WHERE id=$1",
              [f.vm.id],
            );
          const terms = {
            vm_id: f.vm.id,
            expected_funding_version: f.request.funding_epoch,
            home_volume_ids: volumeId ? [volumeId] : [],
            lane: "prepaid" as const,
            cap_usd: "10",
            ends_at: new Date(Date.now() + 3600000).toISOString(),
            activation: "immediate" as const,
            fallback_reasons: [],
          };
          expect(() => canonicalFundingTerms(terms)).not.toThrow();
          const signedReview = await reviewPersonalVmFundingOnBay(
            f.student,
            terms,
          );
          expect(() => canonicalFundingTerms(signedReview)).not.toThrow();
          // Start at the independently approved boundary; no test approval RPC.
          await pools.get(resourceBay)!.query(
            `INSERT INTO compute_vm_personal_consents
          (id,payer_account_id,vm_id,operation_id,terms,review,state,version,approval_url,approval_expires_at)
          VALUES($1,$2,$3,$4,$5,$6,'approved',2,'https://approval.example/test',NOW()+interval '15 minutes')`,
            [consentId, f.student, f.vm.id, randomUUID(), terms, signedReview],
          );
          const opts = {
            account_id: f.student,
            vm_id: f.vm.id,
            consent_id: consentId,
            expected_version: 2,
            expected_funding_version: f.request.funding_epoch,
            operation_id: randomUUID(),
          };
          if (moved) {
            await ensureCourseCreditNoticeSchema();
            await rehomeAccountOnHomeBay({
              account_id: f.student,
              target_account_id: f.student,
              dest_bay_id: courseBay,
            });
          }
          await onBay(studentBay, () => switchVmPersonalFunding(opts));
          await pools
            .get(resourceBay)!
            .query(
              "UPDATE compute_vms SET state='stopped',stopped_at=NOW() WHERE id=$1",
              [f.vm.id],
            );
          const warnings = jest.spyOn(
            getLogger("compute:funding:personal-handoff"),
            "warn",
          );
          loseVmHandoffReceipt = moved;
          await onBay(studentBay, () => processVmPersonalFundingHandoffs());
          if (moved) {
            expect(
              (await onBay(studentBay, () =>
                getVmPersonalFunding({ account_id: f.student, vm_id: f.vm.id }),
              ))!.state,
            ).toBe("preparing");
            await onBay(studentBay, () => processVmPersonalFundingHandoffs());
          }
          expect(warnings.mock.calls).toEqual([]);
          warnings.mockRestore();
          let vm = (await getComputeVmById(f.vm.id))!;
          const binding = vm.metadata.billing.course_funding.binding;
          expect(binding.source).toEqual({
            kind: "personal",
            consent_id: consentId,
          });
          expect(vm.desired_state).toBe("running");
          expect(
            (await onBay(studentBay, () => switchVmPersonalFunding(opts)))
              .state,
          ).toBe("active");
          await (
            await payerApi(f.student)
          ).checkComputeVmFunding({
            account_id: f.student,
            binding,
            dispatch: true,
          });
          await updateComputeInstance(vm, { running: true, ready: true });
          loseSettlement = true;
          await expect(meterCourseVm(vm)).rejects.toThrow(
            /lost committed settlement reply/,
          );
          vm = (await getComputeVmById(f.vm.id))!;
          await meterCourseVm(vm);
          const old = await row(
            payerBay,
            "SELECT state,pricing_snapshot->'meter' AS meter FROM compute_funding_reservations WHERE operation_id=$1",
            [f.request.funding_epoch],
          );
          const next = await row(
            studentBay,
            "SELECT pricing_snapshot->'meter' AS meter FROM compute_funding_reservations WHERE id=$1",
            [consentId],
          );
          expect(old.state).toBe("settled");
          expect(Date.parse(old.meter.transferred_at)).toBeLessThanOrEqual(
            Date.parse(next.meter.running_started_at),
          );
          expect(
            await row(
              payerBay,
              "SELECT count(*)::int AS n FROM compute_funding_reservations WHERE payer_account_id=$1",
              [f.student],
            ),
          ).toEqual({ n: 0 });
          expect(
            await row(
              studentBay,
              "SELECT count(*)::int AS n FROM compute_funding_reservations WHERE payer_account_id=$1",
              [f.student],
            ),
          ).toEqual({ n: withHome ? 2 : 1 });
          if (volumeId) {
            const volume = (await getComputeVolumeById(volumeId))!;
            expect(courseVolumeBinding(volume).source).toEqual({
              kind: "personal",
              consent_id: consentId,
            });
            loseSettlement = true;
            await expect(meterCourseVolume(volume)).rejects.toThrow(
              /lost committed settlement reply/,
            );
            await meterCourseVolume(volume);
            expect(
              await row(
                payerBay,
                "SELECT count(*)::int AS n FROM compute_volumes WHERE id=$1",
                [volumeId],
              ),
            ).toEqual({ n: 0 });
            const oldVolume = await row(
              payerBay,
              "SELECT state,pricing_snapshot->'meter' AS meter FROM compute_funding_reservations WHERE resource_id=$1",
              [volumeId],
            );
            const newVolume = await row(
              studentBay,
              "SELECT pricing_snapshot->'meter' AS meter FROM compute_funding_reservations WHERE resource_id=$1",
              [volumeId],
            );
            expect(oldVolume.state).toBe("settled");
            expect(oldVolume.meter.transferred_at).toBe(
              newVolume.meter.running_started_at,
            );
          }
          if (moved) {
            expect(
              await row(
                studentBay,
                "SELECT count(*)::int AS n FROM compute_vms WHERE id=$1",
                [vm.id],
              ),
            ).toEqual({ n: 0 });
            return;
          }
          await ensureCourseCreditNoticeSchema();
          const resourceNotice: ComputeResourceNotice = {
            id: randomUUID(),
            account_id: f.student,
            resource_id: vm.id,
            resource_kind: "vm",
            resource_name: "Student VM",
            action: "stop",
            phase: "requested",
            observed_at: new Date().toISOString(),
          };
          await remote(resourceBay).computeFundingReceiveResourceNotice(
            resourceNotice,
          );
          const reminderId = randomUUID();
          const reminderGrant = randomUUID();
          await row(
            resourceBay,
            `INSERT INTO notification_course_credit_states
            (id,account_id,grant_id,threshold_usd,below_threshold,generation,as_of)
            VALUES ($1,$2,$3,10,true,2,now()) RETURNING id`,
            [reminderId, f.student, reminderGrant],
          );
          await rehomeAccountOnHomeBay({
            account_id: f.student,
            target_account_id: f.student,
            dest_bay_id: courseBay,
          });
          expect(mockHomes.get(f.student)).toBe(courseBay);
          await remote(courseBay).computeFundingReceiveResourceNotice(
            resourceNotice,
          );
          expect(
            await row(
              courseBay,
              "SELECT count(*)::int AS n FROM notification_targets WHERE event_id=$1 AND target_account_id=$2",
              [resourceNotice.id, f.student],
            ),
          ).toEqual({ n: 1 });
          const completedNotice = {
            ...resourceNotice,
            id: randomUUID(),
            phase: "completed" as const,
          };
          await remote(courseBay).computeFundingReceiveResourceNotice(
            completedNotice,
          );
          expect(
            await row(
              courseBay,
              "SELECT count(*)::int AS n FROM notification_targets WHERE event_id=$1 AND target_account_id=$2",
              [completedNotice.id, f.student],
            ),
          ).toEqual({ n: 1 });
          expect(
            await row(
              courseBay,
              "SELECT grant_id,below_threshold,generation FROM notification_course_credit_states WHERE id=$1",
              [reminderId],
            ),
          ).toEqual({
            grant_id: reminderGrant,
            below_threshold: true,
            generation: 2,
          });
          expect(
            await row(
              courseBay,
              "SELECT count(*)::int AS n FROM compute_vms WHERE id=$1",
              [vm.id],
            ),
          ).toEqual({ n: 0 });
          const consent = await onBay(courseBay, () =>
            getVmPersonalFunding({ account_id: f.student, vm_id: vm.id }),
          );
          expect(consent!.state).toBe("active");
          const remotePreview = await onBay(courseBay, () =>
            previewPersonalVmFunding(f.student, {
              ...consent!.terms,
              expected_funding_version:
                vm.metadata.billing.course_funding.funding_epoch,
            }),
          );
          expect(remotePreview.hourly_usd).toBe("6");
          expect(remotePreview.home_volumes).toHaveLength(withHome ? 1 : 0);
          if (withHome)
            expect(remotePreview.home_volumes?.[0].funding_action).toBe(
              "preserve",
            );
          const cancel = {
            account_id: f.student,
            vm_id: vm.id,
            consent_id: consentId,
            expected_version: consent!.version,
            operation_id: randomUUID(),
          };
          const cancelled = await onBay(courseBay, () =>
            clearVmPersonalFunding(cancel),
          );
          expect(cancelled.state).toBe("cancelled");
          expect(cancelled.committed_usd).toBe(consent!.committed_usd);
          expect(
            await onBay(courseBay, () => clearVmPersonalFunding(cancel)),
          ).toEqual(cancelled);
          await expect(
            requireCourseVmService((await getComputeVmById(vm.id))!, true),
          ).rejects.toThrow(/authorization ended/);
          await expect(
            onBay(courseBay, () =>
              clearVmPersonalFunding({ ...cancel, account_id: f.payer }),
            ),
          ).rejects.toThrow();
          if (volumeId) {
            await expect(
              requireCourseVolumeService(
                (await getComputeVolumeById(volumeId))!,
                true,
              ),
            ).rejects.toThrow(/authorization ended/);
          }
        });
      },
    );

    it.each(["committed", "aborted", "cancelled"] as const)(
      "reviews and hands off a retained disk after student rehome, recovering a lost %s receipt",
      async (outcome) => {
        const f = await fixture();
        const volumeId = randomUUID(),
          epoch = randomUUID(),
          consentId = randomUUID();
        setPolicy(f.student, {});
        await pools
          .get(resourceBay)!
          .query(
            "INSERT INTO purchases(account_id,cost,service,time) VALUES($1,-10,'credit',NOW())",
            [f.student],
          );
        await pools.get(resourceBay)!.query(
          `INSERT INTO compute_volumes (id,name,owner_account_id,owning_bay_id,provider,region,role,funding_mode,
           size_gb,desired_size_gb,effective_size_gb,state,desired_state,attachment_state,attachment_generation,created_at,metadata)
           VALUES ($1,'Retained study data',$2,$3,'nebius','eu-north1','home','account-prepaid',10,10,10,'ready','ready','detached',1,NOW(),$4)`,
          [
            volumeId,
            f.student,
            resourceBay,
            {
              billing: {
                rate: {
                  hourly_cost_usd: "0.01",
                  pricing_snapshot: { provider: "nebius" },
                },
                course_funding: {
                  source: { ...f.request.source, payer_account_id: f.payer },
                  funding_epoch: epoch,
                },
              },
            },
          ],
        );
        await onBay(resourceBay, async () => {
          const volume = await reserveCourseVolume(
            (await getComputeVolumeById(volumeId))!,
          );
          await requireCourseVolumeService(volume, true);
          await pools
            .get(resourceBay)!
            .query(
              "UPDATE compute_volumes SET ready_at=clock_timestamp() WHERE id=$1",
              [volumeId],
            );
          await ensureCourseCreditNoticeSchema();
          await rehomeAccountOnHomeBay({
            account_id: f.student,
            target_account_id: f.student,
            dest_bay_id: courseBay,
          });
        });
        const terms = {
          volume_id: volumeId,
          expected_funding_version: epoch,
          lane: "prepaid" as const,
          cap_usd: "2.0000000000",
          ends_at: new Date(Date.now() + 3600_000).toISOString(),
        };
        await onBay(courseBay, async () => {
          const review = await reviewPersonalVolumeFunding(f.student, terms);
          expect(review.owning_bay_id).toBe(resourceBay);
          expect(review.provider).toBe("nebius");
          await pools.get(courseBay)!.query(
            `INSERT INTO compute_vm_personal_consents
             (id,payer_account_id,volume_id,operation_id,terms,review,state,version,approval_url,approval_expires_at)
             VALUES($1,$2,$3,$4,$5,$6,'pending',1,'https://approval.example/test',NOW()+interval '15 minutes')`,
            [consentId, f.student, volumeId, randomUUID(), terms, review],
          );
          // Independently approved boundary, using the actual approval callback
          // on a payer bay with no local storage row.
          await withFundingAccountTransaction(f.student, (db) =>
            approvePersonalVolumeFunding({
              db,
              payer_account_id: f.student,
              intent_id: consentId,
              terms,
              review,
            }),
          );
          const consent = (await getVolumePersonalFunding({
            account_id: f.student,
            volume_id: volumeId,
          }))!;
          expect(consent.state).toBe("approved");
          losePersonalVolumeReceipt = outcome !== "cancelled";
          dropPersonalVolumeCommand = outcome === "cancelled";
          if (outcome === "aborted") changeVolumeBeforeCommit = volumeId;
          await expect(
            switchVolumePersonalFunding({
              account_id: f.student,
              volume_id: volumeId,
              consent_id: consentId,
              expected_version: consent.version,
              operation_id: randomUUID(),
            }),
          ).rejects.toThrow("lost personal volume commit receipt");
          expect(
            (await getVolumePersonalFunding({
              account_id: f.student,
              volume_id: volumeId,
            }))!.state,
          ).toBe("preparing");
          expect(
            (
              await row(
                courseBay,
                "SELECT committed_usd::numeric>0 AS held FROM compute_vm_personal_consents WHERE id=$1",
                [consentId],
              )
            ).held,
          ).toBe(true);
          if (outcome === "cancelled") {
            const pending = (await getVolumePersonalFunding({
              account_id: f.student,
              volume_id: volumeId,
            }))!;
            const cancelled = await clearVolumePersonalFunding({
              account_id: f.student,
              volume_id: volumeId,
              consent_id: consentId,
              expected_version: pending.version,
              operation_id: randomUUID(),
            });
            expect(cancelled.state).toBe("cancelled");
            expect(toDecimal(cancelled.committed_usd).gt(0)).toBe(true);
          }
          // A second account move must carry the pending command and its hold.
          await rehomeAccountOnHomeBay({
            account_id: f.student,
            target_account_id: f.student,
            dest_bay_id: payerBay,
          });
        });
        await onBay(payerBay, async () => {
          await processRemotePersonalVolumeHandoffs();
          await processRemotePersonalVolumeHandoffs();
          const consent = (await getVolumePersonalFunding({
            account_id: f.student,
            volume_id: volumeId,
          }))!;
          expect(consent.state).toBe(
            outcome === "committed"
              ? "active"
              : outcome === "cancelled"
                ? "cancelled"
                : "rejected",
          );
          if (outcome !== "committed")
            expect(toDecimal(consent.committed_usd).eq(0)).toBe(true);
          expect(
            await row(
              payerBay,
              "SELECT count(*)::int AS n FROM compute_volumes WHERE id=$1",
              [volumeId],
            ),
          ).toEqual({ n: 0 });
          expect(
            await row(
              payerBay,
              "SELECT count(*)::int AS n FROM compute_funding_reservations WHERE payer_account_id=$1 AND resource_id=$2",
              [f.student, volumeId],
            ),
          ).toEqual({ n: 1 });
        });
        const receipt = (
          await row(
            resourceBay,
            "SELECT payload FROM compute_resource_work WHERE id=$1",
            [consentId],
          )
        ).payload.receipt;
        expect(receipt.outcome).toBe(
          outcome === "committed" ? "committed" : "aborted",
        );
        const originalRequest = (
          await row(
            payerBay,
            "SELECT handoff FROM compute_vm_personal_consents WHERE id=$1",
            [consentId],
          )
        ).handoff.remote_volume.request;
        // Replaying a delayed commit, even after an abort and a resource repair,
        // returns the same receipt and cannot resurrect service.
        await pools
          .get(resourceBay)!
          .query("UPDATE compute_volumes SET desired_size_gb=10 WHERE id=$1", [
            volumeId,
          ]);
        expect(
          await remote(resourceBay).computeFundingApplyPersonalVolumeHandoff(
            originalRequest,
          ),
        ).toEqual(receipt);
        await onBay(resourceBay, async () => {
          const volume = (await getComputeVolumeById(volumeId))!;
          expect(volume.metadata.billing.course_funding.source.kind).toBe(
            outcome === "committed" ? "personal" : "course",
          );
          if (outcome === "committed") {
            await requireCourseVolumeService(volume, true);
            await meterCourseVolume(volume);
          }
        });
        if (outcome === "committed") {
          await pools
            .get(payerBay)!
            .query(
              "UPDATE compute_vm_personal_consents SET terms=jsonb_set(terms,'{ends_at}',to_jsonb((clock_timestamp()-interval '1 second')::text)) WHERE id=$1",
              [consentId],
            );
          const before = await row(
            payerBay,
            "SELECT committed_usd FROM compute_vm_personal_consents WHERE id=$1",
            [consentId],
          );
          await onBay(payerBay, () => expirePersonalFundingConsents());
          expect(
            await row(
              payerBay,
              "SELECT state,committed_usd FROM compute_vm_personal_consents WHERE id=$1",
              [consentId],
            ),
          ).toEqual({ state: "expired", ...before });
        }
      },
    );

    it.each(["prepaid", "postpaid"] as const)(
      "routes %s grants, recovers a lost reserve reply, and settles only the payer after rehome",
      async (lane) => {
        const f = await fixture("20", lane);
        const names = [] as string[];
        for (const bay of bays)
          names.push(
            (await row(bay, "SELECT current_database() AS name")).name,
          );
        expect(new Set(names).size).toBe(3);
        expect(calls).toContainEqual({
          bay: courseBay,
          method: "projectReference",
        });
        for (const bay of [resourceBay, courseBay]) {
          expect(
            (
              await row(
                bay,
                "SELECT count(*)::int AS n FROM compute_funding_pools WHERE id=$1",
                [f.allocation.pool.id],
              )
            ).n,
          ).toBe(0);
          expect(
            (
              await row(
                bay,
                "SELECT count(*)::int AS n FROM accounts WHERE account_id=$1",
                [f.payer],
              )
            ).n,
          ).toBe(0);
        }
        expect(
          (
            await row(
              payerBay,
              "SELECT count(*)::int AS n FROM projects WHERE project_id=$1",
              [f.project],
            )
          ).n,
        ).toBe(0);
        expect(
          (
            await row(
              payerBay,
              "SELECT count(*)::int AS n FROM compute_vms WHERE id=$1",
              [f.vm.id],
            )
          ).n,
        ).toBe(0);

        loseReserve = true;
        await expect(
          onBay(resourceBay, () => reserveCourseVmLaunch(f.vm)),
        ).rejects.toThrow("lost committed reserve reply");
        const committed = await row(
          payerBay,
          "SELECT * FROM compute_funding_reservations WHERE resource_id=$1",
          [f.vm.id],
        );
        expect(committed.state).toBe("reserved");
        expect(
          (await onBay(resourceBay, () => getComputeVmById(f.vm.id)))!.metadata
            .billing.course_funding.binding,
        ).toBeUndefined();
        const holds = await onBay(payerBay, () =>
          getAccountFundingHolds({ account_id: f.payer }),
        );
        expect(
          holds[
            lane === "prepaid" ? "prepaid_held_usd" : "postpaid_committed_usd"
          ],
        ).toBe(moneyToDbString("20"));
        const recovered = await onBay(resourceBay, () =>
          recoverExistingCourseVmFunding(f.vm),
        );
        expect(recovered!.metadata.billing.course_funding.binding).toEqual(
          committed.pricing_snapshot.binding,
        );
        expect(calls.filter((c) => c.method === "reserve")).toEqual([
          { bay: payerBay, method: "reserve" },
        ]);
        expect(calls.filter((c) => c.method === "lookup")).toEqual([
          { bay: payerBay, method: "lookup" },
        ]);
        await onBay(resourceBay, () =>
          requireCourseVmService(recovered!, true),
        );
        expect(
          (
            await row(
              payerBay,
              "SELECT state FROM compute_funding_reservations WHERE id=$1",
              [committed.id],
            )
          ).state,
        ).toBe("dispatched");

        // Explicit provider-observation/clock fixture: one minute of actual resource
        // lifecycle state, not a mocked settlement amount or payer-side VM replica.
        const end = new Date(Date.now() - 1000),
          start = new Date(end.valueOf() - 60000);
        await pools
          .get(payerBay)!
          .query(
            "UPDATE compute_funding_reservations SET dispatched_at=$2 WHERE id=$1",
            [committed.id, new Date(start.valueOf() - 1000)],
          );
        await pools.get(resourceBay)!.query(
          `INSERT INTO compute_vm_instances(id,vm_id,generation,running_at,stopped_at,deleted_at)
      VALUES($4,$1,1,$2,$3,$3)`,
          [f.vm.id, start, end, randomUUID()],
        );
        await pools
          .get(resourceBay)!
          .query(
            "UPDATE compute_vms SET state='deleted',desired_state='deleted',stopped_at=$2,deleted_at=$2 WHERE id=$1",
            [f.vm.id, end],
          );

        await onBay(payerBay, () =>
          rehomeAccountOnHomeBay({
            account_id: f.payer,
            target_account_id: f.payer,
            dest_bay_id: courseBay,
          }),
        );
        expect(mockHomes.get(f.payer)).toBe(courseBay);
        expect(
          (
            await row(
              payerBay,
              "SELECT state FROM account_funding_authorities WHERE payer_account_id=$1",
              [f.payer],
            )
          ).state,
        ).toBe("retired");
        expect(
          (
            await row(
              courseBay,
              "SELECT state FROM account_funding_authorities WHERE payer_account_id=$1",
              [f.payer],
            )
          ).state,
        ).toBe("active");
        expect(
          await onBay(courseBay, () =>
            getAccountFundingHolds({ account_id: f.payer }),
          ),
        ).toEqual(holds);
        await expect(
          onBay(payerBay, () => lookupComputeVmFundingLocal(f.request)),
        ).rejects.toThrow(/homed on another/);

        loseSettlement = true;
        await expect(
          onBay(resourceBay, () => meterCourseVm(recovered!)),
        ).rejects.toThrow("lost committed settlement reply");
        const result = await onBay(resourceBay, () =>
          meterCourseVm(recovered!),
        );
        expect(result!.charged_usd).toBe(moneyToDbString("0.10"));
        expect(
          await onBay(resourceBay, () => meterCourseVm(recovered!)),
        ).toEqual(result);
        expect(
          calls.filter((c) => c.method === "settle").map((c) => c.bay),
        ).toEqual([courseBay, courseBay, courseBay]);
        const settled = await row(
          courseBay,
          "SELECT * FROM compute_funding_reservations WHERE id=$1",
          [committed.id],
        );
        expect(settled.state).toBe("settled");
        expect(
          moneyToDbString(
            toDecimal(settled.spent_usd).plus(settled.released_usd),
          ),
        ).toBe(settled.authorized_usd);
        const pool = await row(
          courseBay,
          "SELECT * FROM compute_funding_pools WHERE id=$1",
          [f.allocation.pool.id],
        );
        expect(pool.reserved_usd).toBe(moneyToDbString("0"));
        expect(pool.spent_usd).toBe(result!.charged_usd);
        const hold = await row(
          courseBay,
          "SELECT * FROM account_funding_holds WHERE id=$1",
          [pool.hold_id],
        );
        expect(
          moneyToDbString(toDecimal(hold.remaining_usd).plus(pool.spent_usd)),
        ).toBe(moneyToDbString("20"));
        const ledger = await row(
          courseBay,
          "SELECT (-sum(cost))::text AS balance, count(*) FILTER (WHERE cost>0)::int AS debits FROM purchases WHERE account_id=$1",
          [f.payer],
        );
        expect(toDecimal(ledger.balance).eq("99.90")).toBe(true);
        expect(ledger.debits).toBe(1);
        expect(
          (
            await row(
              resourceBay,
              "SELECT count(*)::int AS n FROM purchases WHERE account_id=$1",
              [f.student],
            )
          ).n,
        ).toBe(0);
        expect(
          (
            await row(
              resourceBay,
              "SELECT count(*)::int AS n FROM compute_funding_reservations WHERE resource_id=$1",
              [f.vm.id],
            )
          ).n,
        ).toBe(0);
        expect(
          (await onBay(resourceBay, () => getComputeVmById(f.vm.id)))!
            .billing_state,
        ).toBe("closed");
      },
      60000,
    );

    it("recovers a lost reserve reply when the payer rehomes before lookup", async () => {
      const f = await fixture();
      loseReserve = true;
      await expect(
        onBay(resourceBay, () => reserveCourseVmLaunch(f.vm)),
      ).rejects.toThrow("lost committed reserve reply");
      const committed = await row(
        payerBay,
        "SELECT * FROM compute_funding_reservations WHERE resource_id=$1",
        [f.vm.id],
      );
      await onBay(payerBay, () =>
        rehomeAccountOnHomeBay({
          account_id: f.payer,
          target_account_id: f.payer,
          dest_bay_id: courseBay,
        }),
      );
      const recovered = await onBay(resourceBay, () =>
        recoverExistingCourseVmFunding(f.vm),
      );
      expect(recovered!.metadata.billing.course_funding.binding).toEqual(
        committed.pricing_snapshot.binding,
      );
      expect(calls.filter((c) => c.method === "reserve")).toHaveLength(1);
      expect(calls.filter((c) => c.method === "lookup")).toEqual([
        { bay: courseBay, method: "lookup" },
      ]);
    }, 60000);

    it("rejects nonbeneficiaries, wrong homes, and mismatched recovery without creating commitments", async () => {
      const f = await fixture();
      await expect(
        onBay(resourceBay, () => assertCourseAccess(f.student, f.project)),
      ).rejects.toThrow(/collaborator/);
      await expect(
        onBay(resourceBay, () =>
          remote(resourceBay).reserveComputeVmFunding(f.request),
        ),
      ).rejects.toThrow(/homed on another/);
      await expect(
        onBay(resourceBay, async () =>
          (await payerApi(f.payer)).reserveComputeVmFunding({
            ...f.request,
            owner_account_id: randomUUID(),
          }),
        ),
      ).rejects.toThrow(/beneficiary/);
      expect(
        (
          await row(
            payerBay,
            "SELECT count(*)::int AS n FROM compute_funding_reservations WHERE payer_account_id=$1",
            [f.payer],
          )
        ).n,
      ).toBe(0);
      await onBay(resourceBay, () => reserveCourseVmLaunch(f.vm));
      await expect(
        onBay(resourceBay, async () =>
          (await payerApi(f.payer)).lookupComputeVmFunding({
            ...f.request,
            resource_generation: 2,
          }),
        ),
      ).rejects.toThrow(/mismatched/);
      expect(
        (
          await row(
            payerBay,
            "SELECT count(*)::int AS n FROM compute_funding_reservations WHERE payer_account_id=$1",
            [f.payer],
          )
        ).n,
      ).toBe(1);
    }, 60000);

    it("serializes competing commitments and ordinary purchase writers on the payer account lock", async () => {
      const f = await fixture("5");
      // Concurrent DB transactions on ONE bay. Separate onBay scopes must not run
      // concurrently in this in-process harness (see its configuration contract).
      await onBay(payerBay, async () => {
        const outcomes = await Promise.allSettled([
          reserveComputeVmFundingLocal(f.request),
          reserveComputeVmFundingLocal({
            ...f.request,
            resource_id: randomUUID(),
            funding_epoch: randomUUID(),
          }),
        ]);
        expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(
          1,
        );
        expect(
          (
            outcomes.find(
              (r) => r.status === "rejected",
            ) as PromiseRejectedResult
          ).reason.message,
        ).toMatch(/allowance/);
        const db = await pools.get(payerBay)!.connect();
        let credit: Promise<number> | undefined;
        try {
          await db.query("BEGIN");
          await lockAccountSpending(db, f.payer);
          expect(
            await getSpendableBalance({
              account_id: f.payer,
              client: db,
              noSave: true,
            }),
          ).toBe(moneyToDbString("95"));
          credit = createCredit({ account_id: f.payer, amount: "1" });
          // Inspect PostgreSQL's wait graph, not a timing-only 'not completed' flag.
          let waiting = false;
          for (let i = 0; i < 100; i++) {
            waiting = (
              await db.query(`SELECT EXISTS(SELECT 1 FROM pg_locks
            WHERE locktype='advisory' AND NOT granted
            AND pg_backend_pid()=ANY(pg_blocking_pids(pid))) AS waiting`)
            ).rows[0].waiting;
            if (waiting) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(waiting).toBe(true);
        } finally {
          await db.query("ROLLBACK");
          db.release();
          await credit;
        }
        expect(
          await getSpendableBalance({ account_id: f.payer, noSave: true }),
        ).toBe(moneyToDbString("96"));
      });
    }, 60000);
  },
);
