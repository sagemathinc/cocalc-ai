import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  adoptLaunchedKey,
  connectGpuPod,
  disconnectGpuPod,
  newLaunchKey,
  settleLaunchKey,
} from "./gpu-connect";
import {
  hasPodKey,
  keyFingerprint,
  listPendingKeys,
  listPodSsh,
} from "./gpu-ssh";

const HANDLE = "cc-abcdefgh234567ab";
// A real ed25519 public key (not a secret), standing in for the pod's.
const HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "gpu-connect-test-"));
  const reflectCalls: string[][] = [];
  let reflectFails = false;
  const deps = {
    home,
    sleep: async () => {},
    runReflect: async (args: string[]) => {
      reflectCalls.push(args);
      if (reflectFails && args[2] === "add") {
        return { code: 1, stdout: "", stderr: "Error: SSH operation failed\n" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ kernel: `reflect-${args[3]}` }),
        stderr: "",
      };
    },
  };
  return {
    home,
    deps,
    reflectCalls,
    failReflect: () => (reflectFails = true),
  };
}

// gpu.sshInfo: not ready for the first `notReady` calls, then ready.
function api(fingerprint: string, notReady = 0, state = "running") {
  let n = 0;
  return {
    calls: () => n,
    sshInfo: async () => {
      n++;
      const base = { handle: HANDLE, state, ssh_key_fingerprint: fingerprint };
      if (n <= notReady || state !== "running")
        return { ...base, ready: false };
      return {
        ...base,
        ready: true,
        host: "203.0.113.7",
        port: 40022,
        user: "root",
        host_public_key: HOST_KEY,
        host_key_fingerprint: keyFingerprint(HOST_KEY),
      };
    },
  };
}

it("launches with a key made here, then connects once the pod has registered", async () => {
  const { home, deps, reflectCalls } = setup();
  const key = await newLaunchKey(deps);
  assert.match(key.publicKey, /^ssh-ed25519 /);
  await adoptLaunchedKey(key, HANDLE, deps);

  const a = api(key.fingerprint, 2);
  const r = await connectGpuPod(a as any, HANDLE, { waitSeconds: 60 }, deps);
  assert.equal(a.calls(), 3);
  assert.deepEqual(r, {
    handle: HANDLE,
    alias: HANDLE,
    host_key_fingerprint: keyFingerprint(HOST_KEY),
    kernel: `reflect-${HANDLE}`,
  });
  // the alias resolves to the pod, with the registered key pinned
  const out = execFileSync(
    "ssh",
    ["-G", "-F", join(home, ".ssh", "config"), HANDLE],
    { encoding: "utf8" },
  );
  assert.match(out, /^hostname 203\.0\.113\.7$/m);
  assert.match(out, /^port 40022$/m);
  assert.match(out, new RegExp(`^hostkeyalias ${HANDLE}$`, "m"));
  // a kernel on the pod's Python, replacing any older registration
  assert.deepEqual(reflectCalls, [
    ["jupyter", "target", "remove", HANDLE, "--json"],
    [
      "jupyter",
      "target",
      "add",
      HANDLE,
      "--json",
      "--host",
      HANDLE,
      "--environment",
      "gpu",
      "--python",
      "/usr/bin/python3",
    ],
  ]);
});

it("finds a key left pending by an interrupted launch, by its fingerprint", async () => {
  const { deps } = setup();
  const key = await newLaunchKey(deps);
  // the launch answered, but the CLI died before renaming the key
  await connectGpuPod(
    api(key.fingerprint) as any,
    HANDLE,
    { kernel: false },
    deps,
  );
  assert.deepEqual(await listPendingKeys(deps), []);
  assert.deepEqual(
    (await listPodSsh(deps)).map((p) => p.handle),
    [HANDLE],
  );
});

it("refuses a pod this project has no key for", async () => {
  const { deps } = setup();
  const other = await newLaunchKey(deps);
  await assert.rejects(
    connectGpuPod(api("SHA256:someone-elses-key") as any, HANDLE, {}, deps),
    /no SSH key for cc-abcdefgh234567ab/,
  );
  // the unrelated pending key is left alone
  assert.deepEqual(
    (await listPendingKeys(deps)).map((k) => k.name),
    [other.name],
  );
});

it("says when the pod is gone, or hasn't registered in time", async () => {
  const { deps } = setup();
  const key = await newLaunchKey(deps);
  await adoptLaunchedKey(key, HANDLE, deps);
  await assert.rejects(
    connectGpuPod(
      api(key.fingerprint, 0, "terminated") as any,
      HANDLE,
      {},
      deps,
    ),
    /is terminated/,
  );
  let t = 0;
  await assert.rejects(
    connectGpuPod(
      api(key.fingerprint, 1000) as any,
      HANDLE,
      { waitSeconds: 10 },
      { ...deps, now: () => (t += 4000) },
    ),
    /hasn't registered its SSH host key yet/,
  );
});

it("keeps the alias but says so when the kernel can't be set up", async () => {
  const { deps, failReflect } = setup();
  const key = await newLaunchKey(deps);
  await adoptLaunchedKey(key, HANDLE, deps);
  failReflect();
  await assert.rejects(
    connectGpuPod(api(key.fingerprint) as any, HANDLE, {}, deps),
    /alias cc-abcdefgh234567ab works, but the Jupyter kernel couldn't be set up: Error: SSH operation failed/,
  );
  assert.deepEqual(
    (await listPodSsh(deps)).map((p) => p.handle),
    [HANDLE],
  );
});

it("forgets a terminated pod here, and leaves SSH config alone for pods it never had", async () => {
  const { home, deps, reflectCalls } = setup();
  assert.equal(await disconnectGpuPod(HANDLE, deps), false);
  assert.ok(!existsSync(join(home, ".ssh", "config")));
  assert.deepEqual(reflectCalls, []);

  const key = await newLaunchKey(deps);
  await adoptLaunchedKey(key, HANDLE, deps);
  await connectGpuPod(
    api(key.fingerprint) as any,
    HANDLE,
    { kernel: false },
    deps,
  );
  assert.equal(await disconnectGpuPod(HANDLE, deps), true);
  assert.deepEqual(await listPodSsh(deps), []);
  assert.ok(!existsSync(join(home, ".ssh", "cocalc-gpu", HANDLE)));
  assert.deepEqual(reflectCalls.at(-1), [
    "jupyter",
    "target",
    "remove",
    HANDLE,
    "--stop",
    "--json",
  ]);
});

it("after a launch error, keeps the key without an answer, else adopts or removes it", async () => {
  const { deps } = setup();
  const pods = (records: any[]) => ({
    pods: async () => ({ records }) as any,
  });
  // no answer (a timeout): the launch may still be running there
  const timedOut = await newLaunchKey(deps);
  const timeout = Object.assign(new Error("timeout"), { code: 408 });
  assert.equal(
    await settleLaunchKey(pods([]), timedOut, timeout, deps),
    "kept",
  );
  const reset = Object.assign(new Error("socket"), { code: "ECONNRESET" });
  assert.equal(await settleLaunchKey(pods([]), timedOut, reset, deps), "kept");
  assert.deepEqual(
    (await listPendingKeys(deps)).map((k) => k.name),
    [timedOut.name],
  );

  // a refusal before anything was made: removed
  const refused = await newLaunchKey(deps);
  assert.equal(
    await settleLaunchKey(
      pods([
        {
          handle: "cc-zzzzzzzzzzzzzzzz",
          state: "running",
          ssh_key_fingerprint: "SHA256:other",
        },
        {
          handle: "cc-yyyyyyyyyyyyyyyy",
          state: "failed",
          ssh_key_fingerprint: refused.fingerprint,
        },
      ]),
      refused,
      new Error("The GPU budget doesn't allow this launch."),
      deps,
    ),
    "discarded",
  );
  // made at RunPod, but its bind wasn't recorded: adopted under its handle
  const made = await newLaunchKey(deps);
  assert.equal(
    await settleLaunchKey(
      pods([
        {
          handle: HANDLE,
          state: "ambiguous",
          ssh_key_fingerprint: made.fingerprint,
        },
      ]),
      made,
      new Error("RunPod created pod, but CoCalc couldn't record it yet."),
      deps,
    ),
    "adopted",
  );
  assert.ok(await hasPodKey(HANDLE, deps));
  // only the unanswered launch's key is still pending
  assert.deepEqual(
    (await listPendingKeys(deps)).map((k) => k.name),
    [timedOut.name],
  );
});

it("terminating a pod whose launch was interrupted removes its pending key", async () => {
  const { deps } = setup();
  const key = await newLaunchKey(deps);
  const other = await newLaunchKey(deps);
  // no alias and no handle key, only the pending key, matched by fingerprint
  assert.equal(await disconnectGpuPod(HANDLE, deps, key.fingerprint), true);
  assert.deepEqual(
    (await listPendingKeys(deps)).map((k) => k.name),
    [other.name],
  );
  // nothing of this pod here: still a no-op
  assert.equal(
    await disconnectGpuPod(HANDLE, deps, "SHA256:nothinghere"),
    false,
  );
});
