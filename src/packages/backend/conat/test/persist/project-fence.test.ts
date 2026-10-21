/*
Project fences (conat/persist/fence.ts): quiesce a project's persistent
streams so their files can be replaced, then let clients load the new
history.

pnpm test ./project-fence.test.ts
*/

import { before, after, connect, wait } from "@cocalc/backend/conat/test/setup";
import { syncFiles } from "@cocalc/conat/persist/context";
import {
  claimPersistFile,
  initPersistFenceService,
  openProjectStreamPaths,
  PERSIST_FENCE_SUBJECT,
  PersistFenceUnavailableError,
  withPersistFence,
} from "@cocalc/conat/persist/fence";
import {
  isProjectFenced,
  projectReplacedInstance,
} from "@cocalc/conat/persist/project-fence";
import {
  currentFenceHolder,
  fileFenceStore,
  isFenceHolderAlive,
} from "@cocalc/backend/conat/persist-fence";
import { copyFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { uuid } from "@cocalc/util/misc";
import { messageData } from "@cocalc/conat/core/client";
import { stream } from "@cocalc/conat/persist/client";
import { resolveLocalPath } from "@cocalc/conat/persist/util";

beforeAll(before);
afterAll(after);

jest.setTimeout(30000);

function findDatabases(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findDatabases(path));
    } else if (entry.name.endsWith(".db")) {
      found.push(path);
    }
  }
  return found;
}

const holder = currentFenceHolder();

describe("fence a project, replace its history, and clients reload it", () => {
  const project_id = uuid();
  let service: { close: () => void };
  let client;
  let doc;
  // a stream whose owner doesn't handle a replacement (e.g., a project log)
  let plain;
  let dbPath: string;
  const saved = () => join(syncFiles.local, `saved-${project_id}.db`);

  it("starts the fence service and opens a project document", async () => {
    service = await initPersistFenceService({
      client: connect(),
      holderAlive: isFenceHolderAlive,
    });
    client = connect();
    doc = await client.sync.dstream({ project_id, name: "fence-doc" });
    // as SyncDoc does: it handles a replacement of the history itself
    doc.keepOpenWhenReplaced();
    doc.publish("a");
    doc.publish("b");
    await doc.save();
    const dbs = findDatabases(join(syncFiles.local, "projects", project_id));
    expect(dbs.length).toBe(1);
    dbPath = dbs[0];
    expect(openProjectStreamPaths(project_id).length).toBe(1);
  });

  it("while fenced, no stream of the project is open, so its files can be copied", async () => {
    await wait({
      until: async () => {
        try {
          await client.request(PERSIST_FENCE_SUBJECT, null, { timeout: 500 });
        } catch (err) {
          // answered (with an error): the service is listening
          return `${err}`.includes("invalid project_id");
        }
        return false;
      },
    });
    const fence = { client: connect(), project_id, holder, replaces: false };
    await withPersistFence(fence, async () => {
      expect(isProjectFenced(project_id)).toBe(true);
      expect(openProjectStreamPaths(project_id)).toEqual([]);
      copyFileSync(dbPath, saved());
    });
    expect(isProjectFenced(project_id)).toBe(false);
  });

  it("the client reconnects after the fence and keeps working", async () => {
    await wait({
      until: async () => {
        doc.publish("c");
        try {
          await doc.save();
          return true;
        } catch {
          return false;
        }
      },
    });
    expect(doc.getAll().slice(0, 3)).toEqual(["a", "b", "c"]);
  });

  it("replaces the history under a fence; the client starts over with it", async () => {
    plain = await client.sync.dstream({ project_id, name: "fence-log" });
    plain.publish("x");
    await plain.save();
    await withPersistFence(
      { client: connect(), project_id, holder },
      async () => {
        expect(openProjectStreamPaths(project_id)).toEqual([]);
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
        copyFileSync(saved(), dbPath);
      },
    );
    await wait({
      until: () => JSON.stringify(doc.getAll()) == JSON.stringify(["a", "b"]),
    });
    expect(doc.getAll()).toEqual(["a", "b"]);
  });

  it("the replaced stream writes nothing more; a new one writes to the new history", async () => {
    expect(doc.isReplaced()).toBe(true);
    doc.publish("stale");
    await doc.save();
    // kept for its owner, never written
    expect(doc.pendingMessages().map(({ mesg }) => mesg)).toEqual(["stale"]);
    const fresh = await client.sync.dstream({ project_id, name: "fence-doc" });
    expect(fresh).not.toBe(doc);
    fresh.publish("d");
    await fresh.save();
    const other = await connect().sync.dstream({
      project_id,
      name: "fence-doc",
    });
    expect(other.getAll()).toEqual(["a", "b", "d"]);
    other.close();
    fresh.close();
  });

  it("a stream whose owner doesn't handle the replacement closes, so it is opened again", async () => {
    await wait({ until: () => plain.isClosed() });
    // never silently dropped
    expect(() => plain.publish("y")).toThrow("closed");
    const again = await client.sync.dstream({ project_id, name: "fence-log" });
    expect(again).not.toBe(plain);
    expect(again.getAll()).toEqual(["x"]);
    again.publish("z");
    await again.save();
    const other = await connect().sync.dstream({
      project_id,
      name: "fence-log",
    });
    expect(other.getAll()).toEqual(["x", "z"]);
    other.close();
    again.close();
  });

  it("a write from a client that has not seen the replacement is refused", async () => {
    const persist = stream({
      client: connect(),
      user: { hub_id: "x" },
      storage: { path: `projects/${project_id}/raw` },
    });
    await persist.set({ messageData: messageData("before") });
    await persist.getAll({});
    const seen = persist.getInstance();
    await withPersistFence(
      { client: connect(), project_id, holder },
      async () => {},
    );
    await wait({ until: () => persist.socket?.state == "ready" });
    await expect(
      persist.set({ messageData: messageData("stale") }),
    ).rejects.toThrow("history was replaced");
    // the refusal told it the new instance, so now it may write
    expect(persist.getInstance()).not.toBe(seen);
    await persist.set({ messageData: messageData("after") });
    persist.close();
  });

  it("opening a stream of a fenced project waits until the fence is released", async () => {
    let opened = false;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const fenced = withPersistFence(
      { client: connect(), project_id, holder },
      async () => {
        const opening = connect()
          .sync.dstream({ project_id, name: "fence-doc-2" })
          .then((s) => {
            opened = true;
            return s;
          });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(opened).toBe(false);
        release();
        // (not the promise itself, which settles only after the release)
        return { opening };
      },
    );
    await released;
    const s = await (await fenced).opening;
    expect(opened).toBe(true);
    s.close();
  });

  it("an ephemeral stream of the project is not closed by a fence", async () => {
    const eph = await client.sync.dstream({
      project_id,
      name: "fence-ephemeral",
      ephemeral: true,
    });
    eph.publish("x");
    await eph.save();
    await withPersistFence(
      { client: connect(), project_id, holder },
      async () => {},
    );
    eph.publish("y");
    await eph.save();
    expect(eph.getAll()).toEqual(["x", "y"]);
    eph.close();
  });

  it("a second fence of the same project is refused while the first is held", async () => {
    await withPersistFence(
      { client: connect(), project_id, holder },
      async () => {
        await expect(
          withPersistFence(
            { client: connect(), project_id, holder },
            async () => {},
          ),
        ).rejects.toThrow("already fenced");
      },
    );
  });

  it("refuses a fence that needs a feature this persist server lacks", async () => {
    await expect(
      withPersistFence(
        {
          client: connect(),
          project_id,
          holder,
          requires: ["persist-volume"],
        },
        async () => {},
      ),
    ).rejects.toThrow("lacks persist-volume");
    expect(isProjectFenced(project_id)).toBe(false);
  });

  it("refuses a holder that is not a running process", async () => {
    await expect(
      withPersistFence(
        { client: connect(), project_id, holder: { pid: 1, start: "x" } },
        async () => {},
      ),
    ).rejects.toThrow("not a running process");
    expect(isProjectFenced(project_id)).toBe(false);
  });

  it("waits for other work on the project's files, and none starts while it is fenced", async () => {
    const fileOf = (id: string) =>
      join(resolveLocalPath(`projects/${id}`, { ephemeral: true }), "x.db");
    const file = fileOf(project_id);
    const release = claimPersistFile(file)!;
    expect(release).toBeDefined();
    await expect(
      withPersistFence(
        { client: connect(), project_id, holder, timeoutMs: 1000 },
        async () => {},
      ),
    ).rejects.toThrow("work on 1 of this project's persist files");
    expect(isProjectFenced(project_id)).toBe(false);
    setTimeout(release, 300);
    await withPersistFence(
      { client: connect(), project_id, holder, replaces: false },
      async () => {
        expect(claimPersistFile(file)).toBeUndefined();
        // another project's files are not affected
        const other = claimPersistFile(fileOf(uuid()));
        expect(other).toBeDefined();
        other!();
      },
    );
    const after = claimPersistFile(file);
    expect(after).toBeDefined();
    after!();
  });

  it("reports when no fence service is running", async () => {
    service.close();
    await wait({
      until: async () => {
        try {
          await withPersistFence(
            { client: connect(), project_id },
            async () => {},
          );
          return false;
        } catch (err) {
          return err instanceof PersistFenceUnavailableError;
        }
      },
    });
  });
});

describe("a person can see what holds a fence", () => {
  const project_id = uuid();
  let service: Awaited<ReturnType<typeof initPersistFenceService>>;

  afterAll(() => service?.close());

  it("lists each fence with its reason, age and holder, also when held long", async () => {
    service = await initPersistFenceService({
      client: connect(),
      holderAlive: () => true,
      describeHolder: () => ({ holder_running: true }),
      holderCheckMs: 20,
      // (logged on both sides while it's held)
      longFenceMs: 50,
    });
    await withPersistFence(
      {
        client: connect(),
        project_id,
        holder,
        reason: "restore-snapshot",
        replaces: false,
        longFenceMs: 50,
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(
          service.fences().filter((f) => f.project_id === project_id),
        ).toEqual([
          {
            project_id,
            reason: "restore-snapshot",
            since: expect.any(String),
            age_seconds: expect.any(Number),
            holder,
            holder_running: true,
          },
        ]);
      },
    );
    expect(service.fences()).toEqual([]);
  });
});

describe("a fence is held until its holder releases it or is gone", () => {
  const project_id = uuid();
  const alive = new Set([1001, 1002]);
  const holderAlive = ({ pid }) => alive.has(pid);
  let dir: string;
  let services: { close: () => void }[] = [];

  afterAll(() => {
    for (const s of services) s.close();
  });

  it("releases the fence of a holder that is gone, never on a timer", async () => {
    dir = join(syncFiles.local, `fences-${project_id}`);
    services.push(
      await initPersistFenceService({
        client: connect(),
        holderAlive,
        store: fileFenceStore(dir),
        holderCheckMs: 100,
      }),
    );
    const c = connect();
    await c.request(PERSIST_FENCE_SUBJECT, {
      cmd: "acquire",
      project_id,
      token: "held",
      holder: { pid: 1001, start: "" },
    });
    expect(isProjectFenced(project_id)).toBe(true);
    // the holder runs: held, however long
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isProjectFenced(project_id)).toBe(true);
    alive.delete(1001);
    await wait({ until: () => !isProjectFenced(project_id) });
    expect(fileFenceStore(dir).load()).toEqual([]);
  });

  it("a restarted service holds again the fences of holders that still run", async () => {
    const store = fileFenceStore(dir);
    store.save({
      project_id,
      token: "kept",
      holder: { pid: 1002, start: "" },
      since: Date.now(),
    });
    const other = uuid();
    store.save({
      project_id: other,
      token: "gone",
      holder: { pid: 1003, start: "" },
      since: Date.now(),
    });
    for (const s of services.splice(0)) s.close();
    services.push(
      await initPersistFenceService({
        client: connect(),
        holderAlive,
        store,
        holderCheckMs: 100,
      }),
    );
    expect(isProjectFenced(project_id)).toBe(true);
    // the fence of a holder that died meanwhile is released, as replaced:
    // its project's streams report a new instance, which is saved
    expect(isProjectFenced(other)).toBe(false);
    const instance = projectReplacedInstance(other);
    expect(instance).toEqual(expect.any(String));
    expect(store.loadInstances()[other]).toBe(instance);
    const c = connect();
    await wait({
      until: async () => {
        try {
          const resp = await c.request(
            PERSIST_FENCE_SUBJECT,
            { cmd: "release", project_id, token: "kept" },
            { timeout: 1000 },
          );
          return resp.data?.released === true;
        } catch {
          return false;
        }
      },
    });
    expect(isProjectFenced(project_id)).toBe(false);
    expect(store.load()).toEqual([]);
  });
});

describe("a dead holder's fence stays held if its new instance can't be saved", () => {
  it("fails closed, then releases once the store works", async () => {
    const project_id = uuid();
    const dir = join(syncFiles.local, `fences-failing-${project_id}`);
    const store = fileFenceStore(dir);
    store.save({
      project_id,
      token: "dead",
      holder: { pid: 2001, start: "" },
      since: Date.now(),
    });
    let failing = true;
    const failingStore = {
      ...store,
      saveInstance: (id: string, instance: string) => {
        if (failing) throw new Error("disk full");
        store.saveInstance(id, instance);
      },
    };
    const service = await initPersistFenceService({
      client: connect(),
      holderAlive: () => false,
      store: failingStore,
      holderCheckMs: 100,
    });
    try {
      expect(isProjectFenced(project_id)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(isProjectFenced(project_id)).toBe(true);
      failing = false;
      await wait({ until: () => !isProjectFenced(project_id) });
      expect(store.loadInstances()[project_id]).toBe(
        projectReplacedInstance(project_id),
      );
    } finally {
      service.close();
    }
  });
});

describe("nothing based on the replaced history reaches the restored one", () => {
  const project_id = uuid();
  let service: { close: () => void };
  const holder = currentFenceHolder();
  const dir = () => join(syncFiles.local, "projects", project_id);
  const databases = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? databases(join(d, e.name))
        : e.name.endsWith(".db")
          ? [join(d, e.name)]
          : [],
    );
  const save = async () => {
    const saved: string[] = [];
    await withPersistFence(
      { client: connect(), project_id, holder, replaces: false },
      async () => {
        for (const path of databases(dir())) {
          copyFileSync(path, `${path}.saved`);
          saved.push(path);
        }
      },
    );
    return saved;
  };
  const putBack = (saved: string[]) => {
    for (const path of saved) {
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      copyFileSync(`${path}.saved`, path);
    }
  };

  beforeAll(async () => {
    service = await initPersistFenceService({
      client: connect(),
      holderAlive: isFenceHolderAlive,
    });
  });
  afterAll(() => service?.close());

  it("a key-value store drops what it had not saved", async () => {
    const kv = await connect().sync.dkv({ project_id, name: "fence-kv" });
    kv.set("x", "baseline");
    await kv.save();
    const saved = await save();
    let replaced: any = undefined;
    kv.on("replaced", (x) => (replaced = x));
    await withPersistFence(
      { client: connect(), project_id, holder },
      async () => {
        kv.set("x", "stale during restore");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        putBack(saved);
      },
    );
    await wait({ until: () => replaced != null });
    expect(replaced.dropped).toEqual({ x: "stale during restore" });
    // give a stale write every chance to land
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const fresh = await connect().sync.dkv({ project_id, name: "fence-kv" });
    expect(fresh.get("x")).toBe("baseline");
    // a change made after the restore is saved
    kv.set("x", "after");
    await kv.save();
    const later = await connect().sync.dkv({ project_id, name: "fence-kv" });
    expect(later.get("x")).toBe("after");
    kv.close();
    fresh.close();
    later.close();
  });

  it("a client that only read single messages learns the instance, and is refused", async () => {
    const persist = stream({
      client: connect(),
      user: { hub_id: "x" },
      storage: { path: `projects/${project_id}/point` },
    });
    const { seq } = await persist.set({ messageData: messageData("before") });
    expect((await persist.get({ seq }))?.data).toBe("before");
    // the answers told it the instance
    expect(persist.getInstance()).not.toBe(undefined);
    await withPersistFence(
      { client: connect(), project_id, holder },
      async () => {},
    );
    await wait({ until: () => persist.socket?.state == "ready" });
    await expect(
      persist.set({ messageData: messageData("stale") }),
    ).rejects.toThrow("history was replaced");
    // and a missing message is still "not found"
    expect(await persist.get({ seq: 1000 })).toBe(undefined);
    persist.close();
  });

  it("an AKV that read a key is refused after a replacement", async () => {
    const kv = connect().sync.akv({ project_id, name: "fence-akv" });
    await kv.set("x", "before");
    expect(await kv.get("x")).toBe("before");
    await withPersistFence(
      { client: connect(), project_id, holder },
      async () => {},
    );
    await expect(
      (async () => {
        for (let i = 0; i < 50; i++) {
          try {
            await kv.set("x", "stale");
            return;
          } catch (err) {
            if (`${err}`.includes("history was replaced")) throw err;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      })(),
    ).rejects.toThrow("history was replaced");
  });

  it("a client from before instances is refused once the stream was replaced", async () => {
    // a project never replaced before: such a client works until then
    const other = uuid();
    const persist = stream({
      client: connect(),
      user: { hub_id: "x" },
      storage: { path: `projects/${other}/old` },
    });
    // sends no persist_instance, as clients from before this did
    (persist as any).instanceHeader = () => undefined;
    await persist.set({ messageData: messageData("before") });
    await withPersistFence(
      { client: connect(), project_id: other, holder },
      async () => {},
    );
    await wait({ until: () => persist.socket?.state == "ready" });
    await expect(
      persist.set({ messageData: messageData("stale") }),
    ).rejects.toThrow("history was replaced");
    persist.close();
  });

  it("a reset of the history from before the replacement is refused", async () => {
    const persist = stream({
      client: connect(),
      user: { hub_id: "x" },
      storage: { path: `projects/${project_id}/reset` },
    });
    await persist.set({ messageData: messageData("a") });
    await persist.getAll({});
    const replace = async () => {
      await withPersistFence(
        { client: connect(), project_id, holder },
        async () => {},
      );
      await wait({ until: () => persist.socket?.state == "ready" });
    };
    await replace();
    await expect(
      persist.resetHistory({ epoch: 1, seed: [] } as any),
    ).rejects.toThrow("history was replaced");
    // (the refusal told it the new instance)
    await replace();
    await expect(persist.purgeArchivedHistory()).rejects.toThrow(
      "history was replaced",
    );
    await replace();
    await expect(persist.config({ config: { max_msgs: 5 } })).rejects.toThrow(
      "history was replaced",
    );
    // reading the configuration is not a change
    await persist.config();
    persist.close();
  });
});

describe("a release that can't be recorded leaves the fence held", () => {
  it("and the holder's release is retried until it is", async () => {
    const project_id = uuid();
    const dir = join(syncFiles.local, `fences-remove-${project_id}`);
    const store = fileFenceStore(dir);
    let failing = true;
    const service = await initPersistFenceService({
      client: connect(),
      holderAlive: isFenceHolderAlive,
      store: {
        ...store,
        remove: (id: string, token: string) => {
          if (failing) throw new Error("disk full");
          store.remove(id, token);
        },
      },
    });
    try {
      await withPersistFence(
        { client: connect(), project_id, holder: currentFenceHolder() },
        async () => {},
      );
      // not released: still held, and still recorded
      expect(isProjectFenced(project_id)).toBe(true);
      expect(store.load().map((r) => r.project_id)).toEqual([project_id]);
      failing = false;
      // the holder's release, retried in the background
      await wait({ timeout: 10000, until: () => !isProjectFenced(project_id) });
      expect(store.load()).toEqual([]);
    } finally {
      service.close();
    }
  });
});

describe("a stream's configuration is not applied to a replaced history", () => {
  it("keeps the restored messages a stale limit would delete", async () => {
    const project_id = uuid();
    const holder = currentFenceHolder();
    const service = await initPersistFenceService({
      client: connect(),
      holderAlive: isFenceHolderAlive,
    });
    try {
      const writer = await connect().sync.dstream({
        project_id,
        name: "fence-config",
      });
      for (const x of ["a", "b", "c", "d"]) writer.publish(x);
      await writer.save();
      const dir = join(syncFiles.local, "projects", project_id);
      const db = readdirSync(dir).find((name) => name.endsWith(".db"));
      expect(db).toBeDefined();
      const path = join(dir, db!);
      await withPersistFence(
        { client: connect(), project_id, holder, replaces: false },
        async () => copyFileSync(path, `${path}.saved`),
      );
      // a client that asks for a lower limit (which trims the stream)
      const limited = await connect().sync.dstream({
        project_id,
        name: "fence-config",
        config: { max_msgs: 2 },
      });
      // (as SyncDoc's stream: open across the replacement)
      limited.keepOpenWhenReplaced();
      await wait({ until: () => limited.getAll().length == 2 });
      // the history is restored under it
      await withPersistFence(
        { client: connect(), project_id, holder },
        async () => {
          rmSync(`${path}-wal`, { force: true });
          rmSync(`${path}-shm`, { force: true });
          copyFileSync(`${path}.saved`, path);
        },
      );
      await wait({ until: () => limited.getAll().length == 4 });
      // give a reapplied limit every chance to trim it
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const reader = await connect().sync.dstream({
        project_id,
        name: "fence-config",
      });
      expect(reader.getAll()).toEqual(["a", "b", "c", "d"]);
      reader.close();
      limited.close();
      writer.close();
    } finally {
      service.close();
    }
  });
});

describe("a persist server with features", () => {
  it("grants a fence that requires them", async () => {
    const project_id = uuid();
    const service = await initPersistFenceService({
      client: connect(),
      holderAlive: isFenceHolderAlive,
      features: ["persist-volume"],
    });
    try {
      let ran = false;
      await withPersistFence(
        {
          client: connect(),
          project_id,
          holder: currentFenceHolder(),
          requires: ["persist-volume"],
          replaces: false,
        },
        async () => {
          ran = isProjectFenced(project_id);
        },
      );
      expect(ran).toBe(true);
    } finally {
      service.close();
    }
  });
});
