/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Launch, terminate and who against a real (PGlite) database and a fake
// RunPod: the records, the events, and the crash-safe create.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { lockGpuAccountFence } from "./account-fence";
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
  providerStartTime,
  STALE_CREATE_MS,
  sshKeyFingerprint,
  terminateGpuPodLocal,
  whoGpuPodLocal,
  launchGpuPod,
} from "./pods";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const PROJECT = "00000000-1000-4000-8000-0000000000aa";
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

// Each account has its own key (and so its own budget: the default, $20 in
// all, 2 pods at once); the list price is $0.50 per GPU-hour.
const LIST_PRICE = 0.5;

function deps(account_id: string, rp = fakeRunpod()) {
  const credential_id = randomUUID();
  return {
    rp,
    credential_id,
    deps: {
      isHomeBay: async () => true,
      isProjectCollaborator: async () => true,
      getLaunchAccess: async () => ({
        client: rp.client as any,
        credential_id,
      }),
      getCleanup: async () => ({ ...rp.client, credential_id }) as any,
      listPrice: async () => LIST_PRICE,
      // the real fence, on the account row it needs (same transaction)
      accountWriteFence: async (db: any, id: string, action: string) => {
        await db.query(
          "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [id],
        );
        await lockGpuAccountFence(db, id, action);
      },
      siteUrl: async () => "https://cocalc.test",
    },
    account_id,
  };
}

async function syncGpuTables() {
  await getPool().query(
    "CREATE TABLE IF NOT EXISTS accounts (account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
  );
  await syncSchema({
    gpu_key_fences: SCHEMA.gpu_key_fences,
    gpu_budget_layers: SCHEMA.gpu_budget_layers,
    gpu_budget_events: SCHEMA.gpu_budget_events,
    gpu_pods: SCHEMA.gpu_pods,
    gpu_pod_events: SCHEMA.gpu_pod_events,
    gpu_pod_reservations: SCHEMA.gpu_pod_reservations,
  });
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
        { url: "https://cocalc.test/gpu/pod-host-key", token: "ccr1.t" },
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
      // the key without its comment, and the one-time registration
      env: {
        EPOCHS: "3",
        PUBLIC_KEY: SSH_KEY.split(" ").slice(0, 2).join(" "),
        CC_HOSTKEY_URL: "https://cocalc.test/gpu/pod-host-key",
        CC_HOSTKEY_TOKEN: "ccr1.t",
      },
      // hardens sshd before it starts, then runs the image's own start
      entrypoint: ["/bin/bash", "-c"],
      cmd: [expect.stringContaining("exec '/start.sh'")],
    });
  });

  it("won't make a body for an SSH pod without its registration", () => {
    expect(() =>
      buildRunpodCreateBody({ handle: "cc-7f3k9q2x" }, SPEC),
    ).toThrow("host-key registration");
    // a pod without SSH keeps the image's own start
    const { ssh_public_key: _k, ...noSsh } = SPEC;
    const body = buildRunpodCreateBody({ handle: "cc-7f3k9q2x" }, noSsh);
    expect(body.cmd).toBeUndefined();
    expect(body.env).toEqual({ EPOCHS: "3" });
  });
});

describeDb("GPU pods", () => {
  beforeAll(async () => {
    await syncGpuTables();
  });

  it("refuses a launch whose key changed between pricing and the fence, recording nothing", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    // a different key at each read
    d.getLaunchAccess = async () => ({
      client: rp.client as any,
      credential_id: randomUUID(),
    });
    await expect(
      launchGpuPodLocal({ account_id, project_id: PROJECT, spec: SPEC }, d),
    ).rejects.toThrow("Your RunPod API key changed during the launch");
    expect(rp.client.createPod).not.toHaveBeenCalled();
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM gpu_pods WHERE key_owner_account_id = $1",
      [account_id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("refuses a launch whose key was replaced in place between pricing and the fence", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    const credential_id = randomUUID();
    // the same record (an in-place replacement keeps its id), rewritten
    let reads = 0;
    d.getLaunchAccess = async () => ({
      client: rp.client as any,
      credential_id,
      revision: `r${++reads}`,
    });
    await expect(
      launchGpuPodLocal({ account_id, project_id: PROJECT, spec: SPEC }, d),
    ).rejects.toThrow("Your RunPod API key changed during the launch");
    expect(rp.client.createPod).not.toHaveBeenCalled();
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

  it.each([408, 409, 418])(
    "treats a %i on create as unclear, never as no pod",
    async (status) => {
      const { deps: d, rp, account_id } = deps(randomUUID());
      rp.client.createPod.mockImplementationOnce(async (body: any) => {
        // RunPod made it, then answered with a non-definitive status
        rp.pods.set(`pod_late${status}`, {
          id: `pod_late${status}`,
          name: body.name,
        });
        throw new RunpodApiError(
          status === 409 ? "conflict" : "invalid",
          status,
        );
      });
      const pod = await launchGpuPodLocal(
        { account_id, project_id: PROJECT, spec: SPEC },
        d,
      );
      expect(pod.state).toBe("running");
      expect(pod.provider_pod_id).toBe(`pod_late${status}`);
    },
  );

  it.each([400, 402, 422])(
    "treats a %i on create as no pod",
    async (status) => {
      const { deps: d, rp, account_id } = deps(randomUUID());
      rp.client.createPod.mockRejectedValueOnce(
        new RunpodApiError("invalid", status),
      );
      await expect(
        launchGpuPodLocal({ account_id, project_id: PROJECT, spec: SPEC }, d),
      ).rejects.toThrow();
      expect(rp.client.findPodsByName).not.toHaveBeenCalled();
    },
  );

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

  it("never acts on a pod with a key other than the one that launched it", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    // the key was replaced (maybe for another RunPod account)
    const replaced = {
      ...d,
      getCleanup: async () =>
        ({ ...rp.client, credential_id: randomUUID() }) as any,
    };
    rp.client.terminatePod.mockClear();
    await expect(
      terminateGpuPodLocal({ account_id, pod_id: pod.handle }, replaced),
    ).rejects.toThrow(/key that has since been replaced.*pod_/);
    expect(rp.client.terminatePod).not.toHaveBeenCalled();
    // still recorded as live, with the terminate pending
    const { rows } = await getPool().query(
      "SELECT state, desired_state FROM gpu_pods WHERE id = $1",
      [pod.id],
    );
    expect(rows[0]).toEqual({ state: "running", desired_state: "terminated" });
    // and a listing with the new key doesn't retry it either
    await listManagedGpuPodsLocal({ account_id }, replaced);
    expect(rp.client.terminatePod).not.toHaveBeenCalled();
  });

  it("asks RunPod to terminate only after recording it, and retries an already-terminating pod", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    // a pending termination, as a failed terminate leaves it
    await getPool().query(
      "UPDATE gpu_pods SET desired_state = 'terminated' WHERE id = $1",
      [pod.id],
    );
    rp.client.terminatePod.mockClear();
    // recording "terminating" fails (no events table): RunPod isn't asked
    await getPool().query(
      "ALTER TABLE gpu_pod_events RENAME TO gpu_pod_events_away",
    );
    try {
      await listManagedGpuPodsLocal({ account_id }, d).catch(() => {});
    } finally {
      await getPool().query(
        "ALTER TABLE gpu_pod_events_away RENAME TO gpu_pod_events",
      );
    }
    expect(rp.client.terminatePod).not.toHaveBeenCalled();
    const { rows } = await getPool().query(
      "SELECT state FROM gpu_pods WHERE id = $1",
      [pod.id],
    );
    expect(rows[0].state).toBe("running");
    // already terminating (recorded earlier): retried
    await getPool().query(
      "UPDATE gpu_pods SET state = 'terminating' WHERE id = $1",
      [pod.id],
    );
    await listManagedGpuPodsLocal({ account_id }, d);
    expect(rp.client.terminatePod).toHaveBeenCalledWith(pod.provider_pod_id);
    expect(rp.pods.size).toBe(0);
  });

  // Fail only the event that records "terminating", so earlier writes (the
  // bind, the terminate request) succeed and this step alone fails.
  async function failTerminatingEvents<T>(fn: () => Promise<T>): Promise<T> {
    await getPool().query(`
      CREATE OR REPLACE FUNCTION gpu_test_fail_terminating() RETURNS trigger AS $$
      BEGIN
        IF NEW.details->>'state' = 'terminating' THEN
          RAISE EXCEPTION 'event write failed (test)';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await getPool().query(
      "CREATE TRIGGER gpu_test_fail_terminating BEFORE INSERT ON gpu_pod_events FOR EACH ROW EXECUTE FUNCTION gpu_test_fail_terminating()",
    );
    try {
      return await fn();
    } finally {
      await getPool().query(
        "DROP TRIGGER gpu_test_fail_terminating ON gpu_pod_events",
      );
    }
  }

  it("a direct terminate asks RunPod only once terminating is recorded", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    rp.client.terminatePod.mockClear();
    await failTerminatingEvents(async () => {
      await expect(
        terminateGpuPodLocal({ account_id, pod_id: pod.handle }, d),
      ).rejects.toThrow("couldn't record the termination yet");
    });
    expect(rp.client.terminatePod).not.toHaveBeenCalled();
    const { rows } = await getPool().query(
      "SELECT state, desired_state FROM gpu_pods WHERE id = $1",
      [pod.id],
    );
    expect(rows[0]).toEqual({ state: "running", desired_state: "terminated" });
    // retried later: terminated
    expect(
      await terminateGpuPodLocal({ account_id, pod_id: pod.handle }, d),
    ).toEqual({ state: "terminated" });
    expect(rp.pods.size).toBe(0);
  });

  it("a raced bind asks RunPod only once terminating is recorded", async () => {
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
    rp.client.terminatePod.mockClear();
    const result = await failTerminatingEvents(async () => {
      release();
      return await launching;
    });
    expect(rp.client.terminatePod).not.toHaveBeenCalled();
    expect([result.state, result.desired_state]).toEqual([
      "running",
      "terminated",
    ]);
    // the next listing records it and terminates the pod
    await listManagedGpuPodsLocal({ account_id }, d);
    expect(rp.pods.size).toBe(0);
  });

  it("a CAS miss acts only on a durably terminating record", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    // already terminating (recorded by someone else): retried
    await getPool().query(
      "UPDATE gpu_pods SET state = 'terminating', desired_state = 'terminated' WHERE id = $1",
      [pod.id],
    );
    rp.client.terminatePod.mockClear();
    expect(
      await terminateGpuPodLocal({ account_id, pod_id: pod.handle }, d),
    ).toEqual({ state: "terminated" });
    expect(rp.client.terminatePod).toHaveBeenCalledTimes(1);
  });

  it("records a duplicate pod before terminating it, and retries a failed terminate", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    rp.client.createPod.mockImplementationOnce(async (body: any) => {
      rp.pods.set("pod_dupaaa", { id: "pod_dupaaa", name: body.name });
      rp.pods.set("pod_dupbbb", {
        id: "pod_dupbbb",
        name: body.name,
        cost: 0.9,
      });
      throw new RunpodApiError("protocol");
    });
    // the duplicate's first terminate fails
    rp.client.terminatePod.mockRejectedValueOnce(
      new RunpodApiError("provider", 503),
    );
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    expect(pod.provider_pod_id).toBe("pod_dupaaa");
    expect(rp.pods.has("pod_dupbbb")).toBe(true);
    // the duplicate is a record of its own, pending termination
    const { rows } = await getPool().query(
      "SELECT state, desired_state, handle FROM gpu_pods WHERE provider_pod_id = 'pod_dupbbb'",
    );
    expect(rows[0]).toEqual(
      expect.objectContaining({
        state: "terminating",
        desired_state: "terminated",
      }),
    );
    expect(rows[0].handle).not.toBe(pod.handle);
    // the next listing retries it
    // it ran for 20 minutes before it was found
    await getPool().query(
      "UPDATE gpu_pods SET running_since = now() - interval '20 minutes' WHERE provider_pod_id = 'pod_dupbbb'",
    );
    const live = await listManagedGpuPodsLocal({ account_id }, d);
    expect(rp.pods.has("pod_dupbbb")).toBe(false);
    expect(live.map((p) => p.provider_pod_id)).toEqual(["pod_dupaaa"]);
    // its spend is settled onto the canonical pod's layer: 20 min at $0.90/h,
    // all of it overrun of a zero hold; the canonical pod's hold is untouched
    const { rows: dup } = await getPool().query(
      `SELECT r.* FROM gpu_pod_reservations r JOIN gpu_pods p ON p.id = r.pod_id
        WHERE p.provider_pod_id = 'pod_dupbbb'`,
    );
    expect(dup).toHaveLength(1);
    expect(dup[0].state).toBe("settled");
    expect(Number(dup[0].reserved_usd)).toBe(0);
    expect(Number(dup[0].spent_usd)).toBeCloseTo(0.3, 3);
    expect(Number(dup[0].overrun_usd)).toBeCloseTo(0.3, 3);
    const { rows: layer } = await getPool().query(
      "SELECT spent_usd, reserved_usd FROM gpu_budget_layers WHERE id = $1",
      [dup[0].layer_id],
    );
    expect(Number(layer[0].spent_usd)).toBeCloseTo(0.3, 3);
    const { rows: canon } = await getPool().query(
      "SELECT reserved_usd, state FROM gpu_pod_reservations WHERE pod_id = $1",
      [pod.id],
    );
    expect(canon[0].state).toBe("active");
    expect(Number(layer[0].reserved_usd)).toBe(Number(canon[0].reserved_usd));
  });

  it("never terminates the pod another resolver just bound", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    rp.client.createPod.mockRejectedValueOnce(new RunpodApiError("network"));
    rp.client.findPodsByName.mockRejectedValueOnce(
      new RunpodApiError("network"),
    );
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    rp.pods.set("pod_racea1", { id: "pod_racea1", name: pod.handle });
    rp.pods.set("pod_raceb1", { id: "pod_raceb1", name: pod.handle });
    // one resolver sees only B and binds it first; the other sees A and B,
    // and by its order would keep A
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    rp.client.findPodsByName
      .mockImplementationOnce(async () => {
        await gate;
        return [rp.pods.get("pod_racea1"), rp.pods.get("pod_raceb1")];
      })
      .mockImplementationOnce(async () => [rp.pods.get("pod_raceb1")]);
    const slow = listManagedGpuPodsLocal({ account_id }, d);
    await listManagedGpuPodsLocal({ account_id }, d);
    release();
    await slow;
    const [row] = await listManagedGpuPodsLocal({ account_id }, d);
    expect(row.provider_pod_id).toBe("pod_raceb1");
    expect(row.state).toBe("running");
    expect([...rp.pods.keys()]).toEqual(["pod_raceb1"]);
  });

  it("never acts on another account's record that conflicts with a duplicate", async () => {
    const owner = deps(randomUUID());
    // X's pod, live, with RunPod id pod_shared1
    owner.rp.client.createPod.mockImplementationOnce(async (body: any) => {
      const p = { id: "pod_shared1", name: body.name, cost: 0.5 };
      owner.rp.pods.set(p.id, p);
      return p;
    });
    const x = await launchGpuPodLocal(
      { account_id: owner.account_id, project_id: PROJECT, spec: SPEC },
      owner.deps,
    );
    // Y's unclear create; Y's lookup (wrongly) also returns pod_shared1
    const other = deps(randomUUID());
    other.rp.client.createPod.mockRejectedValueOnce(
      new RunpodApiError("network"),
    );
    other.rp.client.findPodsByName.mockRejectedValueOnce(
      new RunpodApiError("network"),
    );
    const y = await launchGpuPodLocal(
      { account_id: other.account_id, project_id: PROJECT, spec: SPEC },
      other.deps,
    );
    other.rp.pods.set("pod_aaaaaa", { id: "pod_aaaaaa", name: y.handle });
    other.rp.pods.set("pod_shared1", { id: "pod_shared1", name: y.handle });
    await listManagedGpuPodsLocal({ account_id: other.account_id }, other.deps);
    expect(other.rp.client.terminatePod).not.toHaveBeenCalledWith(
      "pod_shared1",
    );
    const { rows } = await getPool().query(
      "SELECT state FROM gpu_pods WHERE id = $1",
      [x.id],
    );
    expect(rows[0].state).toBe("running");
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
    await syncGpuTables();
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

describe("providerStartTime", () => {
  const created = new Date("2026-10-28T06:00:00Z");
  const now = new Date("2026-10-28T06:20:00Z");
  it("uses RunPod's startedAt, else createdAt, bounded by the intent and now", () => {
    expect(
      providerStartTime(
        {
          startedAt: "2026-10-28T06:05:00Z",
          createdAt: "2026-10-28T06:01:00Z",
        },
        { created },
        now,
      ).toISOString(),
    ).toBe("2026-10-28T06:05:00.000Z");
    expect(
      providerStartTime(
        { createdAt: "2026-10-28T06:01:00Z" },
        { created },
        now,
      ).toISOString(),
    ).toBe("2026-10-28T06:01:00.000Z");
    // before the intent existed, or in the future: clamped
    expect(
      providerStartTime(
        { startedAt: "2026-10-27T00:00:00Z" },
        { created },
        now,
      ).toISOString(),
    ).toBe(created.toISOString());
    expect(
      providerStartTime(
        { startedAt: "2026-10-29T00:00:00Z" },
        { created },
        now,
      ).toISOString(),
    ).toBe(now.toISOString());
    // nothing usable: from the intent (it may have run all along)
    expect(
      providerStartTime(
        { startedAt: "garbage" },
        { created },
        now,
      ).toISOString(),
    ).toBe(created.toISOString());
  });
});
