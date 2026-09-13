import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { deliverComputeResourceNotices } from "./resource-notices";
import { receiveComputeResourceNotice } from "@cocalc/server/notifications/compute-resource";
import type { ComputeResourceNotice } from "@cocalc/util/compute-notifications";
let mockRemote = false;
const mockDeliver = jest.fn();
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({
    home_bay_id: mockRemote
      ? "remote-account-bay"
      : require("@cocalc/server/bay-config").getConfiguredBayId(),
  }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: () => ({
    computeFundingReceiveResourceNotice: mockDeliver,
  }),
}));
beforeAll(async () => before({ noConat: true }), 60000);
afterAll(after);
beforeEach(() => {
  mockRemote = false;
  mockDeliver.mockReset();
});
async function fixture(action = "stop", state = "queued") {
  const account = randomUUID(),
    vm = randomUUID(),
    work = randomUUID();
  await getPool().query(
    "INSERT INTO accounts (account_id,home_bay_id) VALUES ($1,$2)",
    [account, getConfiguredBayId()],
  );
  await getPool().query(
    `INSERT INTO compute_vms (id,owner_account_id,owning_bay_id,name,public_hostname,bootstrap_revision,funding_mode,state,desired_state,provider,instance_generation,metadata)
    VALUES ($1,$2,$3,'QA compute',$1::uuid::text || '.example',2,'account-prepaid','running','running','gcp',1,'{}')`,
    [vm, account, getConfiguredBayId()],
  );
  await getPool().query(
    `INSERT INTO compute_resource_work (id,resource_kind,resource_id,action,idempotency_key,payload,state,created_at,updated_at)
    VALUES ($1,'vm',$2,$3,$4,'{}',$5,now()-interval '1 second',now())`,
    [work, vm, action, `course-${action}:${vm}:${randomUUID()}`, state],
  );
  return { account, vm, work };
}
async function notices(account: string) {
  return (
    await getPool().query(
      "SELECT e.payload_json FROM notification_events e JOIN notification_targets t USING(event_id) WHERE t.target_account_id=$1 ORDER BY e.created_at",
      [account],
    )
  ).rows;
}
it("delivers a durable request then a confirmed stop once each without doing provider work", async () => {
  const f = await fixture();
  await deliverComputeResourceNotices();
  await deliverComputeResourceNotices();
  expect(await notices(f.account)).toHaveLength(1);
  await getPool().query(
    "UPDATE compute_vms SET state='stopped',stopped_at=now() WHERE id=$1",
    [f.vm],
  );
  await getPool().query(
    "UPDATE compute_resource_work SET state='done',updated_at=now() WHERE id=$1",
    [f.work],
  );
  await deliverComputeResourceNotices();
  await deliverComputeResourceNotices();
  const rows = await notices(f.account);
  expect(rows.map((r) => r.payload_json.lifecycle_phase)).toEqual([
    "requested",
    "completed",
  ]);
  expect(rows[1].payload_json.body_markdown).toContain("not deleted");
});
it("does not report a superseded no-op work item as a completed stop", async () => {
  const f = await fixture("stop", "done");
  await deliverComputeResourceNotices();
  expect(await notices(f.account)).toHaveLength(0);
});

it("deduplicates multiple intents that converge on the same physical stop", async () => {
  const f = await fixture("stop", "done");
  await getPool().query(
    "UPDATE compute_vms SET state='stopped',stopped_at=now() WHERE id=$1",
    [f.vm],
  );
  await getPool().query(
    `INSERT INTO compute_resource_work (id,resource_kind,resource_id,action,idempotency_key,payload,state,created_at,updated_at)
    SELECT $2,resource_kind,resource_id,action,idempotency_key || '-retry',payload,state,created_at,updated_at FROM compute_resource_work WHERE id=$1`,
    [f.work, randomUUID()],
  );
  await deliverComputeResourceNotices();
  expect(await notices(f.account)).toHaveLength(1);
});
it("retries an account-bay outage and a lost acknowledgement with the same identity", async () => {
  const f = await fixture("delete");
  mockRemote = true;
  mockDeliver.mockRejectedValueOnce(Error("account bay unavailable"));
  await deliverComputeResourceNotices();
  expect(await notices(f.account)).toHaveLength(0);
  mockDeliver.mockImplementationOnce(async (notice) => {
    await receiveComputeResourceNotice(notice);
    throw Error("lost acknowledgement");
  });
  await deliverComputeResourceNotices();
  expect(await notices(f.account)).toHaveLength(1);
  mockDeliver.mockImplementation(receiveComputeResourceNotice);
  await deliverComputeResourceNotices();
  const calls = mockDeliver.mock.calls.filter(([n]) => n.resource_id === f.vm);
  expect(calls).toHaveLength(3);
  expect(new Set(calls.map(([n]) => n.id)).size).toBe(1);
  expect(await notices(f.account)).toHaveLength(1);
});
it("rejects delivery at the old account home and invalid lifecycle claims", async () => {
  const f = await fixture();
  const notice: ComputeResourceNotice = {
    id: randomUUID(),
    account_id: f.account,
    resource_id: f.vm,
    resource_kind: "volume",
    resource_name: "Home",
    action: "stop",
    phase: "completed",
    observed_at: new Date().toISOString(),
  };
  await expect(receiveComputeResourceNotice(notice)).rejects.toThrow("Invalid");
  notice.resource_kind = "vm";
  await getPool().query(
    "UPDATE accounts SET home_bay_id='new-home' WHERE account_id=$1",
    [f.account],
  );
  await expect(receiveComputeResourceNotice(notice)).rejects.toThrow(
    /homed on/,
  );
  expect(await notices(f.account)).toHaveLength(0);
});

it("reports confirmed home-volume deletion without implying project notebook deletion", async () => {
  const f = await fixture("delete_volume", "done");
  const disk = randomUUID();
  await getPool().query(
    `INSERT INTO compute_volumes (id,owner_account_id,owning_bay_id,name,provider,state,desired_state,metadata,deleted_at)
    VALUES ($1,$2,$3,'Student home','gcp','deleted','deleted','{}',now())`,
    [disk, f.account, getConfiguredBayId()],
  );
  await getPool().query(
    "UPDATE compute_resource_work SET resource_kind='volume',resource_id=$2 WHERE id=$1",
    [f.work, disk],
  );
  await deliverComputeResourceNotices();
  const rows = await notices(f.account);
  expect(rows).toHaveLength(1);
  expect(rows[0].payload_json).toMatchObject({
    resource_kind: "volume",
    lifecycle_action: "delete",
    lifecycle_phase: "completed",
  });
  expect(rows[0].payload_json.body_markdown).toContain(
    "no automatic VM or volume backup",
  );
  expect(rows[0].payload_json.body_markdown).toContain(
    "notebooks saved in your CoCalc project are not deleted",
  );
});

(process.env.COCALC_TEST_USE_PGLITE ? it.skip : it)(
  "serializes duplicate delivery at account home",
  async () => {
    const f = await fixture();
    const notice: ComputeResourceNotice = {
      id: randomUUID(),
      account_id: f.account,
      resource_id: f.vm,
      resource_kind: "vm",
      resource_name: "VM",
      action: "delete",
      phase: "requested",
      observed_at: new Date().toISOString(),
    };
    await Promise.all([
      receiveComputeResourceNotice(notice),
      receiveComputeResourceNotice(notice),
    ]);
    expect(await notices(f.account)).toHaveLength(1);
  },
);
