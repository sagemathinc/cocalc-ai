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
  buildRunpodCreateBody,
  launchGpuPodLocal,
  listManagedGpuPodsLocal,
  newPodHandle,
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
      expect(h).toMatch(/^cc-[a-z2-7]{8}$/);
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

  it("resolves an unclear create by the handle: no pod was made", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    rp.client.createPod.mockRejectedValueOnce(
      new RunpodApiError("provider", 503),
    );
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    expect(pod.state).toBe("failed");
    expect(pod.reason).toMatch(/didn't create/);
  });

  it("keeps an unclear create ambiguous while RunPod can't be asked", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    rp.client.createPod.mockImplementationOnce(async (body: any) => {
      rp.pods.set("pod_later", { id: "pod_later", name: body.name });
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
    expect(pod.handle).toMatch(/^cc-/);
    // A terminate resolves it first, then ends the pod it finds.
    expect(
      await terminateGpuPodLocal({ account_id, pod_id: pod.handle }, d),
    ).toEqual({ state: "terminated" });
    expect(rp.client.terminatePod).toHaveBeenCalledWith("pod_later");
    expect(rp.pods.size).toBe(0);
  });

  it("terminates duplicate pods with the same handle", async () => {
    const { deps: d, rp, account_id } = deps(randomUUID());
    rp.client.createPod.mockImplementationOnce(async (body: any) => {
      rp.pods.set("pod_dup001", { id: "pod_dup001", name: body.name });
      rp.pods.set("pod_dup002", { id: "pod_dup002", name: body.name });
      throw new RunpodApiError("protocol");
    });
    const pod = await launchGpuPodLocal(
      { account_id, project_id: PROJECT, spec: SPEC },
      d,
    );
    expect(pod.provider_pod_id).toBe("pod_dup001");
    expect([...rp.pods.keys()]).toEqual(["pod_dup001"]);
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
    await expect(
      whoGpuPodLocal({ account_id, query: "'; drop table x" }, d),
    ).rejects.toThrow("Give a pod id");
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
