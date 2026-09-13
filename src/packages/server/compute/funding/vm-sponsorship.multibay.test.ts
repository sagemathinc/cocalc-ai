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
import getSpendableBalance, {
  getAccountFundingHolds,
} from "@cocalc/server/purchases/get-spendable-balance";
import { lockAccountSpending } from "@cocalc/server/purchases/lock-account-spending";
import createCredit from "@cocalc/server/purchases/create-credit";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type { ReserveComputeVmFundingRequest } from "@cocalc/util/compute-vm-funding";
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
        site_ceiling_usd: "100",
        bay_quotas: require("./__tests__/multibay-postgres").bays.map(
          (bay_id) => ({ bay_id, amount_usd: "30" }),
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
    const handlers: ReturnType<typeof createServiceHandler>[] = [];
    const calls: { bay: string; method: string }[] = [];
    let loseReserve = false;
    let loseSettlement = false;
    const remote = (bay: string) =>
      createInterBayAccountLocalClient({
        client: fabric,
        dest_bay: bay,
        timeout: 5000,
      });

    beforeAll(async () => {
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
    }, 60000);
    beforeEach(() => {
      calls.length = 0;
      loseReserve = false;
      loseSettlement = false;
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
      (id,owner_account_id,owning_bay_id,provider,instance_generation,state,desired_state,metadata,effective_pricing_model,created_at)
      VALUES($1,$2,$3,'nebius',1,'requested','running',$4,'spot',now())`,
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

    it.each([false, true])(
      "hands approved personal funding from a remote instructor to the student bay and retries lost settlement (home volume: %s)",
      async (withHome) => {
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
          const bound = await reserveCourseVmLaunch(f.vm);
          await requireCourseVmService(bound, true);
          const volumeId = withHome ? randomUUID() : undefined;
          let homeReview: Record<string, unknown>[] = [];
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
            homeReview = [
              {
                id: volumeId,
                funding_epoch: epoch,
                resource_generation: 1,
                attachment_generation: 1,
                size_gb: 10,
                hourly_usd: "0.01",
              },
            ];
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
            lane: "prepaid",
            cap_usd: "10",
            ends_at: new Date(Date.now() + 3600000).toISOString(),
            activation: "immediate",
            fallback_reasons: [],
          };
          // Start at the independently approved boundary; no test approval RPC.
          await pools.get(resourceBay)!.query(
            `INSERT INTO compute_vm_personal_consents
          (id,payer_account_id,vm_id,operation_id,terms,review,state,version,approval_url,approval_expires_at)
          VALUES($1,$2,$3,$4,$5,$6,'approved',2,'https://approval.example/test',NOW()+interval '15 minutes')`,
            [
              consentId,
              f.student,
              f.vm.id,
              randomUUID(),
              terms,
              { home_volumes: homeReview, owning_bay_id: resourceBay },
            ],
          );
          const opts = {
            account_id: f.student,
            vm_id: f.vm.id,
            consent_id: consentId,
            expected_version: 2,
            expected_funding_version: f.request.funding_epoch,
            operation_id: randomUUID(),
          };
          await switchVmPersonalFunding(opts);
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
          await processVmPersonalFundingHandoffs();
          expect(warnings.mock.calls).toEqual([]);
          warnings.mockRestore();
          let vm = (await getComputeVmById(f.vm.id))!;
          const binding = vm.metadata.billing.course_funding.binding;
          expect(binding.source).toEqual({
            kind: "personal",
            consent_id: consentId,
          });
          expect(vm.desired_state).toBe("running");
          expect((await switchVmPersonalFunding(opts)).state).toBe("active");
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
            resourceBay,
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
              resourceBay,
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
              resourceBay,
              "SELECT pricing_snapshot->'meter' AS meter FROM compute_funding_reservations WHERE resource_id=$1",
              [volumeId],
            );
            expect(oldVolume.state).toBe("settled");
            expect(oldVolume.meter.transferred_at).toBe(
              newVolume.meter.running_started_at,
            );
          }
          await ensureCourseCreditNoticeSchema();
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
