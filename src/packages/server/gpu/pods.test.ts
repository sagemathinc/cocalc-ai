/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Launch, terminate and who against a real (PGlite) database and a fake
// RunPod: the records, the events, and the crash-safe create.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { RunpodApiError } from "@cocalc/cloud/runpod/client";
import { GPU_LAUNCH_IMAGES } from "@cocalc/util/gpu/launch-spec";
import {
  AMBIGUOUS_WINDOW_MS,
  buildRunpodCreateBody,
  launchGpuPodLocal,
  listManagedGpuPodsLocal,
  newPodHandle,
  recordSeenAddresses,
  STALE_CREATE_MS,
  sshKeyFingerprint,
  terminateGpuPodLocal,
  whoGpuPodLocal,
  launchGpuPod,
} from "./pods";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const PROJECT = "00000000-1000-4000-8000-0000000000aa";
const CREDENTIAL = "00000000-1000-4000-8000-0000000000cc";
// ssh-keygen -lf prints SHA256:O8VI/... for this key (computed below).
const SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test";
const SPEC = {
  gpu_type_id: "NVIDIA GeForce RTX 4090",
  image: GPU_LAUNCH_IMAGES[0],
  max_runtime_minutes: 60,
  env: { EPOCHS: "3" },
  ssh_public_key: SSH_KEY,
};

function fakeRunpod() {
  const pods = new Map<string, any>();
  const client = {
    createPod: jest.fn(async (body: any) => {
      const pod = {
        id: `pod_${randomUUID().slice(0, 8)}`,
        name: body.name,
        status: "PROVISIONING",
        cost: 0.69,
      };
      pods.set(pod.id, pod);
      return pod;
    }),
    terminatePod: jest.fn(async (id: string) => {
      pods.delete(id);
    }),
    findPodsByName: jest.fn(async (name: string) =>
      [...pods.values()].filter((p) => p.name === name),
    ),
  };
  return { client, pods };
}

function deps(account_id: string, rp = fakeRunpod()) {
  return {
    rp,
    deps: {
      isHomeBay: async () => true,
      isProjectCollaborator: async () => true,
      getLaunchAccess: async () => ({
        client: rp.client as any,
        credential_id: CREDENTIAL,
      }),
      getCleanup: async () => rp.client as any,
    },
    account_id,
  };
}

async function events(pod_id: string) {
  const { rows } = await getPool().query(
    "SELECT actor_kind, action, details FROM gpu_pod_events WHERE pod_id = $1 ORDER BY at, action",
    [pod_id],
  );
  return rows;
}

describe("pod handles, fingerprints and the create body", () => {
  it("makes opaque handles", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const h = newPodHandle();
      expect(h).toMatch(/^cc-[a-z2-7]{16}$/);
      seen.add(h);
    }
    expect(seen.size).toBe(200);
  });

  it("fingerprints a key as ssh-keygen -lf does", () => {
    expect(sshKeyFingerprint(SSH_KEY)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it("sets the name and SSH key itself, and adds the SSH port", () => {
    expect(
      buildRunpodCreateBody(
        { handle: "cc-7f3k9q2x" },
        {
          ...SPEC,
          gpu_count: 2,
          cloud: "COMMUNITY",
          data_center_id: "US-KS-2",
          container_disk_gb: 30,
          volume_gb: 50,
          ports: ["8888/http"],
        },
      ),
    ).toEqual({
      name: "cc-7f3k9q2x",
      image: SPEC.image,
      gpu: { id: SPEC.gpu_type_id, count: 2 },
      cloud: "COMMUNITY",
      dataCenterIds: ["US-KS-2"],
      disk: 30,
      mounts: { persistent: { size: 50, path: "/workspace" } },
      ports: ["8888/http", "22/tcp"],
      env: { EPOCHS: "3", PUBLIC_KEY: SSH_KEY },
    });
  });
});

describeDb("GPU pods", () => {
  beforeAll(async () => {
    await syncSchema({
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_events: SCHEMA.gpu_pod_events,
    });
  });

  it("records the intent, creates the pod by its handle, and binds it", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    expect(pod).toEqual(
      expect.objectContaining({
        state: "running",
        desired_state: "running",
        key_owner_account_id: account_id,
        beneficiary_account_id: account_id,
        project_id: PROJECT,
        cost_per_hr: "0.6900000000",
        ssh_key_fingerprint: sshKeyFingerprint(SSH_KEY),
      }),
    );
    expect(rp.client.createPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: pod.handle }),
    );
    expect(pod.provider_pod_id).toBe([...rp.pods.keys()][0]);
    // env values never reach the record
    const { rows } = await getPool().query(
      "SELECT spec FROM gpu_pods WHERE id = $1",
      [pod.id],
    );
    expect(JSON.stringify(rows[0].spec)).not.toContain('"3"');
    expect(JSON.stringify(rows[0].spec)).not.toContain(SSH_KEY.split(" ")[1]);
    expect((await events(pod.id)).map((e) => e.action).sort()).toEqual([
      "bind",
      "create",
    ]);
  });

  it("checks project access and the spec before calling RunPod", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    await expect(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC },
        { ...d, isProjectCollaborator: async () => false },
      ),
    ).rejects.toThrow("access denied");
    await expect(
      launchGpuPodLocal(
        {
          account_id,
          project_id: PROJECT,
          spec: { ...SPEC, image: "evil/miner" },
        },
        d,
      ),
    ).rejects.toThrow("image must be one of");
    await expect(
      launchGpuPodLocal({ account_id, project_id: "x", spec: SPEC }, d),
    ).rejects.toThrow("needs a project");
    await expect(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC },
        { ...d, isHomeBay: async () => false },
      ),
    ).rejects.toThrow("home bay");
    expect(rp.client.createPod).not.toHaveBeenCalled();
    expect(await listManagedGpuPodsLocal({ account_id }, d)).toEqual([]);
  });

  it("marks a refused create failed, with the reason in words", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    rp.client.createPod.mockRejectedValueOnce(
      new RunpodApiError("invalid", 402),
    );
    await expect(
      launchGpuPodLocal({ account_id, project_id: PROJECT, spec: SPEC }, d),
    ).rejects.toThrow("balance is too low");
    const [pod] = await listManagedGpuPodsLocal(
      { account_id, include_ended: true },
      d,
    );
    expect(pod.state).toBe("failed");
    expect(pod.terminated_at).toBeDefined();
    expect(rp.client.findPodsByName).not.toHaveBeenCalled();
  });

  it("resolves an unclear create by the handle: the pod was made", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    rp.client.createPod.mockImplementationOnce(async (body: any) => {
      // RunPod made it, but the reply was lost.
      rp.pods.set("pod_lostreply", { id: "pod_lostreply", name: body.name });
      throw new RunpodApiError("network");
    });
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    expect(pod.state).toBe("running");
    expect(pod.provider_pod_id).toBe("pod_lostreply");
    expect(rp.client.findPodsByName).toHaveBeenCalledWith(pod.handle);
  });

  it("keeps an empty lookup ambiguous while RunPod's listing may lag, and binds the pod when it shows up", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    let handle = "";
    rp.client.createPod.mockImplementationOnce(async (body: any) => {
      handle = body.name;
      throw new RunpodApiError("provider", 503);
    });
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    // Not visible yet: not proof that no pod was made.
    expect(pod.state).toBe("ambiguous");
    // A terminate is kept for when it is resolved.
    expect(
      await terminateGpuPodLocal({ account_id, pod_id: pod.handle }, d),
    ).toEqual({ state: "ambiguous" });
    // The pod appears late; the next listing resolves the record, binds it
    // and, as terminate was asked for, terminates it.
    rp.pods.set("pod_late01", { id: "pod_late01", name: handle });
    await listManagedGpuPodsLocal({ account_id }, d);
    const [ended] = await listManagedGpuPodsLocal(
      { account_id, include_ended: true },
      d,
    );
    expect(ended).toEqual(
      expect.objectContaining({
        state: "terminated",
        provider_pod_id: "pod_late01",
      }),
    );
    expect(rp.pods.size).toBe(0);
  });

  it("gives up an unclear create only after the consistency window", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    rp.client.createPod.mockRejectedValueOnce(
      new RunpodApiError("provider", 503),
    );
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    expect(pod.state).toBe("ambiguous");
    const later = { ...d, now: () => Date.now() + AMBIGUOUS_WINDOW_MS + 1 };
    expect(await listManagedGpuPodsLocal({ account_id }, later)).toEqual([]);
    const [failed] = await listManagedGpuPodsLocal(
      { account_id, include_ended: true },
      later,
    );
    expect(failed.state).toBe("failed");
    expect(failed.reason).toMatch(/didn't create/);
  });

  it("binds once when two resolutions race, and terminates a pod the record doesn't hold", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    let handle = "";
    rp.client.createPod.mockImplementationOnce(async (body: any) => {
      handle = body.name;
      throw new RunpodApiError("network");
    });
    rp.client.findPodsByName.mockRejectedValueOnce(
      new RunpodApiError("network"),
    );
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    expect(pod.state).toBe("ambiguous");
    rp.pods.set("pod_race01", { id: "pod_race01", name: handle });
    // two listings resolve the same record at once
    await Promise.all([
      listManagedGpuPodsLocal({ account_id }, d),
      listManagedGpuPodsLocal({ account_id }, d),
    ]);
    const binds = (await events(pod.id)).filter((e) => e.action === "bind");
    expect(binds).toHaveLength(1);
    expect(rp.pods.has("pod_race01")).toBe(true);
  });

  it("terminates the losing pod when two resolutions see different pods", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    rp.client.createPod.mockRejectedValueOnce(new RunpodApiError("network"));
    rp.client.findPodsByName.mockRejectedValueOnce(
      new RunpodApiError("network"),
    );
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    expect(pod.state).toBe("ambiguous");
    rp.pods.set("pod_aaaaaa", { id: "pod_aaaaaa", name: pod.handle });
    rp.pods.set("pod_bbbbbb", { id: "pod_bbbbbb", name: pod.handle });
    // each lookup sees only one of them (a listing taken mid-retry)
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // (mocks are taken in call order: the slow listing starts first)
    rp.client.findPodsByName
      .mockImplementationOnce(async () => {
        await gate;
        return [rp.pods.get("pod_bbbbbb")];
      })
      .mockImplementationOnce(async () => [rp.pods.get("pod_aaaaaa")]);
    const slow = listManagedGpuPodsLocal({ account_id }, d);
    await listManagedGpuPodsLocal({ account_id }, d);
    release();
    await slow;
    const [row] = await listManagedGpuPodsLocal({ account_id }, d);
    expect(row.provider_pod_id).toBe("pod_aaaaaa");
    expect([...rp.pods.keys()]).toEqual(["pod_aaaaaa"]);
    const ev = await events(pod.id);
    expect(ev.filter((e) => e.action === "bind")).toHaveLength(1);
    expect(ev).toContainEqual(
      expect.objectContaining({
        action: "terminate",
        details: { provider_pod_id: "pod_bbbbbb", duplicate: true },
      }),
    );
  });

  it("never records a state change without its event, or the reverse", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    const before = (await events(pod.id)).length;
    // the event can't be written (the table is away): the terminate is not
    // recorded either, and nothing is sent to RunPod
    await getPool().query(
      "ALTER TABLE gpu_pod_events RENAME TO gpu_pod_events_away",
    );
    try {
      await expect(
        terminateGpuPodLocal({ account_id, pod_id: pod.handle }, d),
      ).rejects.toThrow();
    } finally {
      await getPool().query(
        "ALTER TABLE gpu_pod_events_away RENAME TO gpu_pod_events",
      );
    }
    const { rows } = await getPool().query(
      "SELECT desired_state, state FROM gpu_pods WHERE id = $1",
      [pod.id],
    );
    expect(rows[0]).toEqual({ desired_state: "running", state: "running" });
    expect((await events(pod.id)).length).toBe(before);
    expect(rp.client.terminatePod).not.toHaveBeenCalled();
  });

  it("retries a handle collision with a new handle", async () => {
    const { deps: d, account_id } = deps(randomUUID());
    const first = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    const handles = [first.handle, newPodHandle()];
    const second = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      { ...d, newHandle: () => handles.shift()! },
    );
    expect(second.handle).not.toBe(first.handle);
    expect(second.state).toBe("running");
  });

  it("terminates by id, handle or RunPod id, once, recording who", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    expect(
      await terminateGpuPodLocal(
        { account_id, pod_id: pod.provider_pod_id },
        d,
      ),
    ).toEqual({ state: "terminated" });
    expect(rp.pods.size).toBe(0);
    // again: nothing more is sent
    expect(
      await terminateGpuPodLocal({ account_id, pod_id: pod.id }, d),
    ).toEqual({ state: "terminated" });
    expect(rp.client.terminatePod).toHaveBeenCalledTimes(1);
    expect(await listManagedGpuPodsLocal({ account_id }, d)).toEqual([]);
    const ev = await events(pod.id);
    expect(ev).toContainEqual(
      expect.objectContaining({ actor_kind: "key_owner", action: "terminate" }),
    );
  });

  it("terminates a pod whose create is still in flight when it binds", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const create = rp.client.createPod.getMockImplementation()!;
    rp.client.createPod.mockImplementationOnce(async (body: any) => {
      await gate;
      return await create(body);
    });
    const launching = launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    let pod;
    for (let i = 0; i < 100 && !pod; i++) {
      await new Promise((r) => setTimeout(r, 10));
      [pod] = await listManagedGpuPodsLocal({ account_id }, d);
    }
    expect(pod.state).toBe("creating");
    expect(
      await terminateGpuPodLocal({ account_id, pod_id: pod.handle }, d),
    ).toEqual({ state: "creating" });
    release();
    expect((await launching).state).toBe("terminated");
    expect(rp.pods.size).toBe(0);
  });

  it("retries the termination of a raced bind until RunPod confirms it", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const create = rp.client.createPod.getMockImplementation()!;
    rp.client.createPod.mockImplementationOnce(async (body: any) => {
      await gate;
      return await create(body);
    });
    const launching = launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    let pod;
    for (let i = 0; i < 100 && !pod; i++) {
      await new Promise((r) => setTimeout(r, 10));
      [pod] = await listManagedGpuPodsLocal({ account_id }, d);
    }
    await terminateGpuPodLocal({ account_id, pod_id: pod.handle }, d);
    // RunPod fails the first terminate after the bind
    rp.client.terminatePod.mockRejectedValueOnce(
      new RunpodApiError("provider", 503),
    );
    release();
    const result = await launching;
    expect(result.state).toBe("terminating");
    expect(result.desired_state).toBe("terminated");
    expect(rp.pods.size).toBe(1);
    // the next listing retries, and this time RunPod confirms
    expect(await listManagedGpuPodsLocal({ account_id }, d)).toEqual([]);
    expect(rp.pods.size).toBe(0);
  });

  it("keeps each account's pods to itself", async () => {
    const owner = deps(randomUUID());
    const other = deps(randomUUID(), owner.rp);
    const pod = await launchGpuPodLocal(
      { account_id: owner.account_id, project_id: PROJECT, spec: SPEC },
      owner.deps,
    );
    await expect(
      terminateGpuPodLocal(
        { account_id: other.account_id, pod_id: pod.handle },
        other.deps,
      ),
    ).rejects.toThrow("No such GPU pod");
    expect(
      await whoGpuPodLocal(
        { account_id: other.account_id, query: pod.provider_pod_id },
        other.deps,
      ),
    ).toEqual([]);
    expect(
      await listManagedGpuPodsLocal(
        { account_id: other.account_id },
        other.deps,
      ),
    ).toEqual([]);
    expect(owner.rp.client.terminatePod).not.toHaveBeenCalled();
  });

  it("answers who with the pod's record and its events, and logs the lookup", async () => {
    const { deps: d, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    const [hit] = await whoGpuPodLocal(
      { account_id, query: pod.provider_pod_id },
      d,
    );
    expect(hit.pod.id).toBe(pod.id);
    expect(hit.events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["create", "bind"]),
    );
    expect((await events(pod.id)).map((e) => e.action)).toContain("who_lookup");
    // by our id (a UUID), the handle, and RunPod's id
    for (const query of [pod.id, pod.handle, pod.provider_pod_id]) {
      const [h] = await whoGpuPodLocal({ account_id, query }, d);
      expect(h.pod.id).toBe(pod.id);
    }
    await expect(
      whoGpuPodLocal({ account_id, query: "'; drop table x" }, d),
    ).rejects.toThrow("Give a pod id");
  });

  it("shows the newest 200 events of a long history", async () => {
    const { deps: d, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    for (let i = 0; i < 205; i++) {
      await whoGpuPodLocal({ account_id, query: pod.handle }, d);
    }
    const [h] = await whoGpuPodLocal({ account_id, query: pod.handle }, d);
    expect(h.events).toHaveLength(200);
    // the earliest events (create, bind) have aged out; the latest is there
    expect(h.events.map((e) => e.action)).not.toContain("create");
    const times = h.events.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
  });

  it("says when no key is connected", async () => {
    const { deps: d, account_id } = deps(randomUUID());
    await expect(
      launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC },
        { ...d, getLaunchAccess: async () => undefined },
      ),
    ).rejects.toThrow("No RunPod API key is connected");
  });
});

describeDb("GPU pods left behind and seen again", () => {
  beforeAll(async () => {
    await syncSchema({
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_events: SCHEMA.gpu_pod_events,
    });
  });

  it("resolves records a crash left in intent or creating", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    // two launches whose server died: one before sending, one mid-create
    // (RunPod made that pod)
    const a = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    const b = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    rp.pods.clear();
    rp.pods.set("pod_crash1", { id: "pod_crash1", name: b.handle });
    await getPool().query(
      "UPDATE gpu_pods SET state = 'intent', provider_pod_id = NULL, updated = now() - interval '1 hour' WHERE id = $1",
      [a.id],
    );
    await getPool().query(
      "UPDATE gpu_pods SET state = 'creating', provider_pod_id = NULL, updated = now() - interval '1 hour' WHERE id = $1",
      [b.id],
    );
    expect(STALE_CREATE_MS).toBeLessThan(60 * 60_000);
    const live = await listManagedGpuPodsLocal({ account_id }, d);
    expect(live.map((p) => [p.id, p.state, p.provider_pod_id])).toEqual([
      [b.id, "running", "pod_crash1"],
    ]);
    const [ended] = await listManagedGpuPodsLocal(
      { account_id, include_ended: true },
      d,
    ).then((all) => all.filter((p) => p.id === a.id));
    expect(ended.state).toBe("failed");
  });

  it("terminates a crash-left create's pod without any listing first", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    // the server died mid-create; RunPod made the pod
    rp.pods.clear();
    rp.pods.set("pod_crash2", { id: "pod_crash2", name: pod.handle });
    await getPool().query(
      "UPDATE gpu_pods SET state = 'creating', provider_pod_id = NULL, updated = now() - interval '1 hour' WHERE id = $1",
      [pod.id],
    );
    rp.client.terminatePod.mockClear();
    expect(
      await terminateGpuPodLocal({ account_id, pod_id: pod.handle }, d),
    ).toEqual({ state: "terminated" });
    expect(rp.client.findPodsByName).toHaveBeenCalledWith(pod.handle);
    expect(rp.client.terminatePod).toHaveBeenCalledWith("pod_crash2");
    expect(rp.pods.size).toBe(0);
  });

  it("fails a crash-left intent on terminate, with no RunPod call", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    await getPool().query(
      "UPDATE gpu_pods SET state = 'intent', provider_pod_id = NULL, updated = now() - interval '1 hour' WHERE id = $1",
      [pod.id],
    );
    rp.client.findPodsByName.mockClear();
    rp.client.terminatePod.mockClear();
    expect(
      await terminateGpuPodLocal({ account_id, pod_id: pod.handle }, d),
    ).toEqual({ state: "failed" });
    expect(rp.client.findPodsByName).not.toHaveBeenCalled();
    expect(rp.client.terminatePod).not.toHaveBeenCalled();
  });

  it("leaves a fresh create in flight on terminate", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    await getPool().query(
      "UPDATE gpu_pods SET state = 'creating', provider_pod_id = NULL WHERE id = $1",
      [pod.id],
    );
    rp.client.findPodsByName.mockClear();
    expect(
      await terminateGpuPodLocal({ account_id, pod_id: pod.handle }, d),
    ).toEqual({ state: "creating" });
    expect(rp.client.findPodsByName).not.toHaveBeenCalled();
    const { rows } = await getPool().query(
      "SELECT desired_state FROM gpu_pods WHERE id = $1",
      [pod.id],
    );
    expect(rows[0].desired_state).toBe("terminated");
  });

  it("leaves a fresh intent or create alone", async () => {
    const { deps: d, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    await getPool().query(
      "UPDATE gpu_pods SET state = 'creating', provider_pod_id = NULL WHERE id = $1",
      [pod.id],
    );
    const [row] = await listManagedGpuPodsLocal({ account_id }, d);
    expect(row.state).toBe("creating");
  });

  it("keeps old live pods when ended ones are included", async () => {
    const { deps: d, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    await getPool().query(
      "UPDATE gpu_pods SET created = now() - interval '40 days' WHERE id = $1",
      [pod.id],
    );
    const all = await listManagedGpuPodsLocal(
      { account_id, include_ended: true },
      d,
    );
    expect(all.map((p) => p.id)).toEqual([pod.id]);
  });

  it("records each new IP once, and who finds the pod by an earlier IP", async () => {
    const { deps: d, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    const view = (ip: string) => ({
      id: pod.provider_pod_id!,
      sshDirect: { host: ip, port: 22, username: "root" },
      runtime: { ports: [{ private: 22, public: 40022, type: "tcp", ip }] },
    });
    await recordSeenAddresses([pod], [view("203.0.113.7")] as any);
    await recordSeenAddresses([pod], [view("203.0.113.7")] as any);
    await recordSeenAddresses([pod], [view("198.51.100.9")] as any);
    const seen = (await events(pod.id)).filter((e) => e.action === "ip_seen");
    expect(seen.map((e) => e.details.public_ip)).toEqual([
      "203.0.113.7",
      "198.51.100.9",
    ]);
    const [hit] = await whoGpuPodLocal({ account_id, query: "203.0.113.7" }, d);
    expect(hit.pod.id).toBe(pod.id);
  });
});

describe("routing", () => {
  it("forwards a launch whole to the key owner's home bay", async () => {
    const account_id = randomUUID();
    const remote = { gpuLaunch: jest.fn(async () => ({ id: "x" }) as any) };
    await launchGpuPod(
      {
        account_id,
        project_id: PROJECT,
        spec: SPEC,
        // anything else a caller adds stays behind
        getLaunchAccess: "x",
      } as any,
      { homeClient: async () => remote as any },
    );
    expect(remote.gpuLaunch).toHaveBeenCalledWith({
      account_id,
      project_id: PROJECT,
      spec: SPEC,
    });
  });
});
