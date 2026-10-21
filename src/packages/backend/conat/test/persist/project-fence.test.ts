/*
Project fences (conat/persist/fence.ts): quiesce a project's persistent
streams so their files can be replaced, then let clients load the new
history.

pnpm test ./project-fence.test.ts
*/

import { before, after, connect, wait } from "@cocalc/backend/conat/test/setup";
import { syncFiles } from "@cocalc/conat/persist/context";
import {
  initPersistFenceService,
  openProjectStreamPaths,
  PERSIST_FENCE_SUBJECT,
  PersistFenceUnavailableError,
  withPersistFence,
} from "@cocalc/conat/persist/fence";
import { isProjectFenced } from "@cocalc/conat/persist/project-fence";
import { copyFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { uuid } from "@cocalc/util/misc";

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

describe("fence a project, replace its history, and clients reload it", () => {
  const project_id = uuid();
  let service: { close: () => void };
  let client;
  let doc;
  let dbPath: string;
  const saved = () => join(syncFiles.local, `saved-${project_id}.db`);

  it("starts the fence service and opens a project document", async () => {
    service = initPersistFenceService({ client: connect() });
    client = connect();
    doc = await client.sync.dstream({ project_id, name: "fence-doc" });
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
    const fence = { client: connect(), project_id, replaces: false };
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
    await withPersistFence({ client: connect(), project_id }, async () => {
      expect(openProjectStreamPaths(project_id)).toEqual([]);
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      copyFileSync(saved(), dbPath);
    });
    await wait({
      until: () => JSON.stringify(doc.getAll()) == JSON.stringify(["a", "b"]),
    });
    expect(doc.getAll()).toEqual(["a", "b"]);
  });

  it("writes after the replacement land in the new history", async () => {
    doc.publish("d");
    await doc.save();
    const other = await connect().sync.dstream({
      project_id,
      name: "fence-doc",
    });
    expect(other.getAll()).toEqual(["a", "b", "d"]);
    other.close();
  });

  it("opening a stream of a fenced project waits until the fence is released", async () => {
    let opened = false;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const fenced = withPersistFence(
      { client: connect(), project_id },
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
    await withPersistFence({ client: connect(), project_id }, async () => {});
    eph.publish("y");
    await eph.save();
    expect(eph.getAll()).toEqual(["x", "y"]);
    eph.close();
  });

  it("a second fence of the same project is refused while the first is held", async () => {
    await withPersistFence({ client: connect(), project_id }, async () => {
      await expect(
        withPersistFence({ client: connect(), project_id }, async () => {}),
      ).rejects.toThrow("already fenced");
    });
  });

  it("a lease that is not renewed expires", async () => {
    const c = connect();
    const token = "lease-test";
    await c.request(PERSIST_FENCE_SUBJECT, {
      cmd: "acquire",
      project_id,
      token,
      ttl_ms: 5000,
    });
    expect(isProjectFenced(project_id)).toBe(true);
    await wait({ timeout: 15000, until: () => !isProjectFenced(project_id) });
    await expect(
      c.request(PERSIST_FENCE_SUBJECT, { cmd: "renew", project_id, token }),
    ).rejects.toThrow("not held");
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
