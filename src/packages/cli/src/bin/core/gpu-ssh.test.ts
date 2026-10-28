import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  checkEndpoint,
  ensurePodKey,
  gpuSshInclude,
  listPodSsh,
  removePodSsh,
  withIncludeFirst,
  writePodSsh,
} from "./gpu-ssh";

const HANDLE = "cc-7f3k2qxa";
const OTHER = "cc-b2c3d4e5";
// A real ed25519 public key (made once with ssh-keygen; not a secret).
const HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

function home() {
  return mkdtempSync(join(tmpdir(), "gpu-ssh-test-"));
}

// What OpenSSH resolves for an alias, without connecting.
function resolved(h: string, alias: string): Record<string, string[]> {
  const out = execFileSync(
    "ssh",
    ["-G", "-F", join(h, ".ssh", "config"), alias],
    {
      encoding: "utf8",
    },
  );
  const opts: Record<string, string[]> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf(" ");
    if (i < 0) continue;
    (opts[line.slice(0, i)] ??= []).push(line.slice(i + 1));
  }
  return opts;
}

const endpoint = (over = {}) => ({
  handle: HANDLE,
  host: "203.0.113.7",
  port: 40022,
  user: "root",
  hostKey: HOST_KEY,
  ...over,
});

it("refuses anything that could inject an SSH config line", () => {
  for (const bad of [
    { handle: "cc-UPPER123" },
    { handle: "../../etc" },
    { host: "203.0.113.7\n  ProxyCommand sh -c evil" },
    { host: "-oProxyCommand=evil" },
    { host: "" },
    { port: 0 },
    { port: 70000 },
    { port: 22.5 },
    { user: "root\nHost *" },
    { user: "Root" },
    { hostKey: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC" },
    { hostKey: `${HOST_KEY}\n${HOST_KEY}` },
    { hostKey: "ssh-ed25519 AAAA" },
    { hostKey: `${HOST_KEY} a b` },
  ]) {
    assert.throws(
      () => checkEndpoint(endpoint(bad)),
      Error,
      JSON.stringify(bad),
    );
  }
  // a trailing comment on the reported key is dropped, not written
  assert.equal(
    checkEndpoint(endpoint({ hostKey: `${HOST_KEY} root@pod` })).hostKey,
    HOST_KEY,
  );
});

it("makes the pod's ed25519 key once, private to the project", async () => {
  const h = home();
  const pub = await ensurePodKey(HANDLE, { home: h });
  assert.match(pub, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ cc-7f3k2qxa$/);
  assert.equal(await ensurePodKey(HANDLE, { home: h }), pub);
  const key = join(h, ".ssh", "cocalc-gpu", HANDLE);
  assert.equal(statSync(key).mode & 0o777, 0o600);
  assert.equal(statSync(join(h, ".ssh", "cocalc-gpu")).mode & 0o777, 0o700);
});

it("puts the pod alias first, so a `Host *` below can't weaken it", async () => {
  const h = home();
  mkdirSync(join(h, ".ssh"), { mode: 0o700 });
  // like this project's own config
  const userConfig =
    "Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  IdentityFile ~/.ssh/id_other\n\nHost alpha\n  HostName alpha.example\n";
  writeFileSync(join(h, ".ssh", "config"), userConfig, { mode: 0o600 });
  await ensurePodKey(HANDLE, { home: h });
  await writePodSsh(endpoint(), { home: h });

  const config = readFileSync(join(h, ".ssh", "config"), "utf8");
  assert.equal(config.split("\n")[0], gpuSshInclude({ home: h }));
  assert.ok(config.endsWith(userConfig), "the user's own config is kept as is");

  const o = resolved(h, HANDLE);
  assert.deepEqual(o.hostname, ["203.0.113.7"]);
  assert.deepEqual(o.port, ["40022"]);
  assert.deepEqual(o.user, ["root"]);
  assert.deepEqual(o.hostkeyalias, [HANDLE]);
  assert.deepEqual(o.identitiesonly, ["yes"]);
  assert.deepEqual(o.identityagent, ["none"]);
  assert.deepEqual(o.forwardagent, ["no"]);
  assert.deepEqual(o.stricthostkeychecking, ["true"]);
  assert.deepEqual(o.userknownhostsfile, [
    join(h, ".ssh", "cocalc-gpu", "known_hosts"),
  ]);
  // The pod key comes first; IdentitiesOnly keeps ssh from offering the
  // agent's keys. (OpenSSH still lists Host * IdentityFiles after it.)
  assert.equal(o.identityfile[0], join(h, ".ssh", "cocalc-gpu", HANDLE));

  assert.equal(
    readFileSync(join(h, ".ssh", "cocalc-gpu", "known_hosts"), "utf8"),
    `${HANDLE} ${HOST_KEY}\n`,
  );
  // other hosts are untouched
  assert.deepEqual(resolved(h, "alpha").hostname, ["alpha.example"]);
});

it("refreshes a pod in place, keeps others, and forgets one completely", async () => {
  const h = home();
  await ensurePodKey(HANDLE, { home: h });
  await ensurePodKey(OTHER, { home: h });
  await Promise.all([
    writePodSsh(endpoint(), { home: h }),
    writePodSsh(endpoint({ handle: OTHER, port: 41000 }), { home: h }),
  ]);
  // a restart moved the port: refresh, same pinned key
  await writePodSsh(endpoint({ port: 40100 }), { home: h });
  assert.deepEqual(
    (await listPodSsh({ home: h })).map((p) => [p.handle, p.port]),
    [
      [OTHER, 41000],
      [HANDLE, 40100],
    ].sort(),
  );
  assert.deepEqual(resolved(h, HANDLE).port, ["40100"]);
  const config = readFileSync(join(h, ".ssh", "config"), "utf8");
  assert.equal(
    config.split("\n").filter((l) => l === gpuSshInclude({ home: h })).length,
    1,
  );

  await removePodSsh(HANDLE, { home: h });
  assert.deepEqual(
    (await listPodSsh({ home: h })).map((p) => p.handle),
    [OTHER],
  );
  assert.ok(!existsSync(join(h, ".ssh", "cocalc-gpu", HANDLE)));
  assert.ok(!existsSync(join(h, ".ssh", "cocalc-gpu", `${HANDLE}.pub`)));
  assert.doesNotMatch(
    readFileSync(join(h, ".ssh", "cocalc-gpu", "known_hosts"), "utf8"),
    new RegExp(HANDLE),
  );
  // the alias no longer resolves to the pod
  assert.notDeepEqual(resolved(h, HANDLE).hostname, ["203.0.113.7"]);
});

it("won't write an alias for a pod without its key", async () => {
  await assert.rejects(
    writePodSsh(endpoint(), { home: home() }),
    /no SSH key for cc-7f3k2qxa/,
  );
});

it("moves an existing Include to the top, once", () => {
  const inc = 'Include "/h/.ssh/cocalc-gpu/config"';
  assert.equal(withIncludeFirst("", inc), `${inc}\n`);
  assert.equal(
    withIncludeFirst(`Host *\n  User x\n${inc}\n`, inc),
    `${inc}\n\nHost *\n  User x\n`,
  );
  const once = withIncludeFirst("Host a\n", inc);
  assert.equal(withIncludeFirst(once, inc), once);
});
