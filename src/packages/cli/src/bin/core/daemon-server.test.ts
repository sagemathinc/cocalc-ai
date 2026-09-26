import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonServerOps, type DaemonServerState } from "./daemon-server";
import { prepareDaemonAuthGlobals } from "./daemon-globals";

type Context = { secret: string; closed: boolean };
function fixture(create?: (globals: any) => Promise<Context>) {
  const created: Context[] = [];
  const state: DaemonServerState<Context> = {
    startedAtMs: Date.now(),
    daemonFingerprint: "test",
    socketPath: "unused",
    pidPath: "unused",
    contexts: new Map(),
    closing: false,
  };
  const data = async ({ ctx }: { ctx: Context }) => {
    assert.equal(ctx.closed, false);
    return ctx.secret;
  };
  const ops = createDaemonServerOps<Context>({
    daemonContextKey: JSON.stringify,
    prepareDaemonContextGlobals: prepareDaemonAuthGlobals,
    contextForGlobals: async (globals) => {
      const ctx = create
        ? await create(globals)
        : { secret: globals.apiKey, closed: false };
      created.push(ctx);
      return ctx;
    },
    closeCommandContext: (ctx) => {
      if (ctx) ctx.closed = true;
    },
    globalsFrom: (x) => x,
    daemonContextMeta: () => ({ api: "test", account_id: "test" }),
    projectFileListData: data,
    projectFileCatData: data,
    projectFilePutData: data,
    projectFileGetData: data,
    projectFileRmData: data,
    projectFileMkdirData: data,
    projectFileRgData: data,
    projectFileFdData: data,
  });
  return {
    created,
    state,
    request: (path: string) =>
      ops.handleDaemonAction(state, {
        id: "test",
        action: "project.file.list",
        globals: { apiKeyFile: path },
      }),
    managedRequest: (keyFile: string) =>
      ops.handleDaemonAction(state, {
        id: "managed",
        action: "project.file.list",
        globals: {
          managedConnector: {
            keyFile,
            sourceProjectId: "00000000-0000-4000-8000-000000000001",
          },
        },
      }),
  };
}

test("daemon reuses an unchanged key but invalidates on rotation and removal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-key-file-")),
    path = join(dir, "key");
  const f = fixture();
  try {
    writeFileSync(path, "first", { mode: 0o600 });
    assert.equal((await f.request(path)).data, "first");
    assert.equal((await f.request(path)).data, "first");
    assert.equal(f.created.length, 1);
    writeFileSync(path + ".next", "second", { mode: 0o600 });
    renameSync(path + ".next", path);
    assert.equal((await f.request(path)).data, "second");
    assert.equal(f.created[0].closed, true);
    assert.equal(f.state.contexts.size, 1);
    rmSync(path);
    const removed = await f.request(path);
    assert.equal(removed.ok, false);
    assert.match(removed.error!, /unavailable/);
    assert.equal(f.created[1].closed, true);
    assert.equal(f.state.contexts.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed daemon providers invalidate cached contexts across rotation and loss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-managed-")),
    path = join(dir, "key");
  const f = fixture(async (globals) => ({
    secret: globals.managedConnector.keySnapshot ?? "source-only",
    closed: false,
  }));
  try {
    writeFileSync(path, "first", { mode: 0o600 });
    assert.equal((await f.managedRequest(path)).data, "first");
    assert.equal((await f.managedRequest(path)).data, "first");
    assert.equal(f.created.length, 1);
    writeFileSync(path + ".next", "second", { mode: 0o600 });
    renameSync(path + ".next", path);
    assert.equal((await f.managedRequest(path)).data, "second");
    assert.equal(f.created[0].closed, true);
    rmSync(path);
    assert.equal((await f.managedRequest(path)).data, "source-only");
    assert.equal(f.created[1].closed, true);
    assert.equal(f.state.contexts.size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a delayed old connection cannot repopulate the cache after rotation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daemon-key-race-")),
    path = join(dir, "key");
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async (globals) => {
    if (globals.apiKey === "first") await wait;
    return { secret: globals.apiKey, closed: false };
  });
  try {
    writeFileSync(path, "first", { mode: 0o600 });
    const pending = f.request(path);
    writeFileSync(path + ".next", "second", { mode: 0o600 });
    renameSync(path + ".next", path);
    assert.equal((await f.request(path)).data, "second");
    release();
    const old = await pending;
    assert.equal(old.ok, false);
    assert.match(old.error!, /changed during/);
    assert.equal(f.created.find((ctx) => ctx.secret === "first")?.closed, true);
    assert.equal(f.state.contexts.size, 1);
    assert.equal((await f.request(path)).data, "second");
  } finally {
    release();
    rmSync(dir, { recursive: true, force: true });
  }
});
