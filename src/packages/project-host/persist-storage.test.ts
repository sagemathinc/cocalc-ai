import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DataEncoding } from "@cocalc/conat/core/codec";
import { pstream } from "@cocalc/backend/conat/persist";
import {
  applyPersistStorage,
  listPersistStorage,
  sqliteFreeBytes,
} from "./persist-storage";
import { READY_MARKER } from "./persist-volume";

// whether the project's streams are fenced, as the code under test sees it
let fenced = false;
const fenceOpts: any[] = [];
jest.mock("./persist-fence", () => ({
  withProjectPersistFenced: jest.fn(async (opts, fn) => {
    fenceOpts.push(opts);
    fenced = true;
    try {
      return await fn();
    } finally {
      fenced = false;
    }
  }),
}));

const PROJECT = "11111111-2222-4333-8444-555555555555";
const LEGACY = ".local/share/cocalc/persist";
const DAY = 24 * 60 * 60 * 1000;

let mount: string;
let env: NodeJS.ProcessEnv;
let home: string;
let root: string;

beforeEach(async () => {
  mount = await mkdtemp(join(tmpdir(), "persist-storage-"));
  env = { COCALC_SYNC_PROJECTS: `${mount}/project-[project_id]/${LEGACY}` };
  home = join(mount, `project-${PROJECT}`);
  root = join(mount, `project-${PROJECT}-persist`);
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, READY_MARKER), "{}");
  fenceOpts.length = 0;
});

afterEach(async () => {
  await rm(mount, { recursive: true, force: true });
});

// a stream with `n` entries of `size` bytes, the first `old` of them written
// long ago
async function makeStream(
  name: string,
  {
    n = 10,
    size = 4096,
    old = 0,
  }: { n?: number; size?: number; old?: number } = {},
): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, ".."), { recursive: true });
  const stream = pstream({ path, noCache: true });
  for (let i = 0; i < n; i++) {
    stream.set({
      encoding: DataEncoding.MsgPack,
      // (incompressible: the storage compresses entries)
      raw: randomBytes(size),
    });
  }
  stream.close();
  if (old > 0) {
    const db = new DatabaseSync(`${path}.db`);
    // (in seconds, as the storage keeps it)
    db.prepare("UPDATE messages SET time=? WHERE seq<=?").run(
      (Date.now() - 60 * DAY) / 1000,
      old,
    );
    db.close();
  }
  return path;
}

function count(path: string): number {
  const db = new DatabaseSync(`${path}.db`);
  try {
    return Number(
      (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as any).n,
    );
  } finally {
    db.close();
  }
}

describe("listPersistStorage", () => {
  it("lists the streams by size, with what they belong to", async () => {
    await makeStream("patchflow/home/user/a.md", { n: 5 });
    await makeStream("patchflow/home/user/gone.md", { n: 2 });
    await makeStream("acp-log/home/user/x.chat", { n: 40 });
    await makeStream("jupyter/home/user/n.ipynb", { n: 1 });
    await makeStream("project-log", { n: 3 });
    await writeFile(join(home, "a.md"), "a");
    await writeFile(join(home, "x.chat"), "x");
    const list = await listPersistStorage({ project_id: PROJECT, env });
    expect(list.supported).toBe(true);
    expect(list.streams.map((s) => s.name)).toEqual([
      "acp-log/home/user/x.chat",
      "patchflow/home/user/a.md",
      "project-log",
      "patchflow/home/user/gone.md",
      "jupyter/home/user/n.ipynb",
    ]);
    expect(list.streams[0]).toMatchObject({
      kind: "agent-log",
      document: "/home/user/x.chat",
      document_exists: true,
      bytes: expect.any(Number),
      modified: expect.any(Number),
    });
    expect(list.streams[0].bytes).toBeGreaterThan(40 * 4096);
    const byName = Object.fromEntries(list.streams.map((s) => [s.name, s]));
    expect(byName["patchflow/home/user/gone.md"]).toMatchObject({
      kind: "edit-history",
      document_exists: false,
    });
    expect(byName["project-log"]).toMatchObject({ kind: "project" });
    expect(byName["project-log"].document).toBeUndefined();
    expect(byName["jupyter/home/user/n.ipynb"].kind).toBe("notebook");
    expect(list.total.count).toBe(5);
    expect(list.by_kind["edit-history"]?.count).toBe(2);
    // at most `limit`, but totals over all
    const two = await listPersistStorage({
      project_id: PROJECT,
      env,
      limit: 2,
    });
    expect(two.streams).toHaveLength(2);
    expect(two.total).toEqual(list.total);
  });

  it("never looks through a symlink in the project's home", async () => {
    await makeStream("patchflow/home/user/link/secret.md", { n: 1 });
    const outside = join(mount, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.md"), "s");
    await symlink(outside, join(home, "link"));
    const list = await listPersistStorage({ project_id: PROJECT, env });
    expect(list.streams[0].document_exists).toBeUndefined();
  });

  it("is not supported while the history is in the home", async () => {
    const inHome = { COCALC_SYNC_PROJECTS: join(mount, "persist") };
    expect(
      (await listPersistStorage({ project_id: PROJECT, env: inHome }))
        .supported,
    ).toBe(false);
    await rm(join(root, READY_MARKER));
    expect(
      await listPersistStorage({ project_id: PROJECT, env }),
    ).toMatchObject({ supported: true, streams: [] });
  });

  it("reads free pages from the sqlite header", async () => {
    const path = await makeStream("acp-log/home/user/big.chat", {
      n: 50,
      size: 16384,
    });
    const db = new DatabaseSync(`${path}.db`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("DELETE FROM messages WHERE seq <= 40");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    expect(await sqliteFreeBytes(`${path}.db`)).toBeGreaterThan(40 * 16384);
    expect(await sqliteFreeBytes(join(root, READY_MARKER))).toBe(0);
  });
});

describe("applyPersistStorage", () => {
  it("deletes whole streams while the project's streams are fenced", async () => {
    const gone = await makeStream("patchflow/home/user/sub/gone.md");
    const kept = await makeStream("patchflow/home/user/kept.md");
    const { withProjectPersistFenced } = require("./persist-fence");
    (withProjectPersistFenced as jest.Mock).mockImplementationOnce(
      async (opts, fn) => {
        fenceOpts.push(opts);
        fenced = true;
        try {
          // nothing is deleted before the fence is held
          expect(existsSync(`${gone}.db`)).toBe(true);
          return await fn();
        } finally {
          fenced = false;
        }
      },
    );
    const result = await applyPersistStorage({
      project_id: PROJECT,
      actions: [{ op: "delete", name: "patchflow/home/user/sub/gone.md" }],
      env,
    });
    expect(result.results).toEqual([
      expect.objectContaining({ ok: true, op: "delete" }),
    ]);
    expect(result.freed).toBeGreaterThan(10 * 4096);
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(existsSync(`${gone}.db${suffix}`)).toBe(false);
    }
    // the directory it left empty goes too, not the volume
    expect(existsSync(join(root, "patchflow/home/user/sub"))).toBe(false);
    expect(existsSync(`${kept}.db`)).toBe(true);
    expect(existsSync(join(root, READY_MARKER))).toBe(true);
    // clients reload what changed under the fence
    expect(fenceOpts[0]).toMatchObject({
      project_id: PROJECT,
      reason: "manage-history",
      requires: "persist-volume",
    });
    expect(fenceOpts[0].replaces).toBeUndefined();
  });

  it("refuses anything that is not exactly one of the project's streams", async () => {
    await makeStream("patchflow/home/user/a.md");
    await makeStream("acp-log/home/user/real.chat");
    await symlink(
      join(root, "acp-log/home/user/real.chat.db"),
      join(root, "acp-log/home/user/link.chat.db"),
    );
    const names = [
      "../x",
      "/etc/passwd",
      "patchflow//home/user/a.md",
      "patchflow/home/user/./a.md",
      "patchflow/home/user/missing.md",
      "acp-log/home/user/link.chat",
      READY_MARKER,
      "",
    ];
    const { results } = await applyPersistStorage({
      project_id: PROJECT,
      actions: names.map((name) => ({ op: "delete" as const, name })),
      env,
    });
    expect(results.every((r) => !r.ok && r.error)).toBe(true);
    expect(existsSync(join(root, "patchflow/home/user/a.md.db"))).toBe(true);
    expect(existsSync(join(root, "acp-log/home/user/real.chat.db"))).toBe(true);
    // each action on its own: a valid one still happens
    const mixed = await applyPersistStorage({
      project_id: PROJECT,
      actions: [
        { op: "delete", name: "../x" },
        { op: "delete", name: "patchflow/home/user/a.md" },
      ],
      env,
    });
    expect(mixed.results.map((r) => r.ok)).toEqual([false, true]);
  });

  it("trims old log entries and gives back their space", async () => {
    const path = await makeStream("acp-log/home/user/x.chat", {
      n: 40,
      size: 16384,
      old: 30,
    });
    const { results, freed } = await applyPersistStorage({
      project_id: PROJECT,
      actions: [
        {
          op: "trim",
          name: "acp-log/home/user/x.chat",
          policy: { kind: "since", since: Date.now() - 30 * DAY },
        },
      ],
      env,
    });
    expect(results[0]).toMatchObject({ ok: true, removed: 30 });
    expect(count(path)).toBe(10);
    expect(freed).toBeGreaterThan(20 * 16384);
  });

  it("trims by time only the logs, on the host too", async () => {
    await makeStream("patchflow/home/user/a.md", { n: 5, old: 5 });
    await makeStream("jupyter/home/user/n.ipynb", { n: 5, old: 5 });
    await makeStream("other/x", { n: 5, old: 5 });
    const { results } = await applyPersistStorage({
      project_id: PROJECT,
      actions: [
        "patchflow/home/user/a.md",
        "jupyter/home/user/n.ipynb",
        "other/x",
      ].map((name) => ({
        op: "trim" as const,
        name,
        policy: { kind: "since" as const, since: Date.now() },
      })),
      env,
    });
    expect(results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(results[0].error).toMatch(
      /"since" applies to agent-log and project streams, not edit-history/,
    );
    for (const name of [
      "patchflow/home/user/a.md",
      "jupyter/home/user/n.ipynb",
      "other/x",
    ]) {
      expect(count(join(root, name))).toBe(5);
    }
    const unknown = await applyPersistStorage({
      project_id: PROJECT,
      actions: [
        {
          op: "trim",
          name: "patchflow/home/user/a.md",
          policy: { kind: "tiered" } as any,
        },
        { op: "trim", name: "patchflow/home/user/a.md" } as any,
      ],
      env,
    });
    expect(unknown.results.map((r) => r.error)).toEqual([
      expect.stringMatching(/unknown policy: tiered/),
      expect.stringMatching(/unknown policy/),
    ]);
  });

  it("deletes a deleted document's history only if it is still gone", async () => {
    const gone = await makeStream("patchflow/home/user/gone.md");
    const back = await makeStream("patchflow/home/user/back.md");
    const linked = await makeStream("patchflow/home/user/link/x.md");
    await mkdir(join(mount, "outside"));
    await symlink(join(mount, "outside"), join(home, "link"));
    const { withProjectPersistFenced } = require("./persist-fence");
    (withProjectPersistFenced as jest.Mock).mockImplementationOnce(
      async (_opts, fn) => {
        // made again after the list, before the fence was held
        await writeFile(join(home, "back.md"), "again");
        return await fn();
      },
    );
    const { results } = await applyPersistStorage({
      project_id: PROJECT,
      actions: [gone, back, linked].map((path) => ({
        op: "delete" as const,
        name: path.slice(root.length + 1),
        ifDocumentMissing: true,
      })),
      env,
    });
    expect(results).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({
        ok: true,
        freed: 0,
        skipped: "its document exists again",
      }),
      expect.objectContaining({
        ok: true,
        freed: 0,
        skipped: "whether its document exists can't be told",
      }),
    ]);
    expect(results[0].skipped).toBeUndefined();
    expect(existsSync(`${gone}.db`)).toBe(false);
    expect(existsSync(`${back}.db`)).toBe(true);
    expect(existsSync(`${linked}.db`)).toBe(true);
  });

  it("drops a document's archived history, never cuts its history by time", async () => {
    const path = join(root, "patchflow/home/user/a.md");
    await mkdir(join(path, ".."), { recursive: true });
    const stream = pstream({ path, noCache: true });
    for (let i = 0; i < 20; i++) {
      stream.set({
        encoding: DataEncoding.MsgPack,
        raw: randomBytes(8192),
      });
    }
    expect(stream.resetHistory({ archive: true }).reset).toBe(true);
    expect(stream.historyArchives().length).toBe(1);
    stream.close();
    const refused = await applyPersistStorage({
      project_id: PROJECT,
      actions: [
        {
          op: "trim",
          name: "patchflow/home/user/a.md",
          policy: { kind: "since", since: Date.now() },
        },
      ],
      env,
    });
    expect(refused.results[0]).toMatchObject({
      ok: false,
      error: expect.stringMatching(/applies to agent-log and project streams/),
    });
    const { results } = await applyPersistStorage({
      project_id: PROJECT,
      actions: [
        {
          op: "trim",
          name: "patchflow/home/user/a.md",
          policy: { kind: "without-archived" },
        },
      ],
      env,
    });
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[0].removed).toBeGreaterThanOrEqual(20);
    expect(results[0].freed).toBeGreaterThan(10 * 8192);
    const reopened = pstream({ path, noCache: true });
    try {
      expect(reopened.historyArchives().every((a) => !a.segments?.length)).toBe(
        true,
      );
    } finally {
      reopened.close();
    }
  });

  it("deletes the copies the persist server keeps of a stream", async () => {
    const archive = join(mount, "archive");
    const withCopies = { ...env, COCALC_SYNC_ARCHIVE: archive };
    await makeStream("acp-log/home/user/x.chat");
    const copy = join(archive, "projects", PROJECT, "acp-log/home/user/x.chat");
    await mkdir(join(copy, ".."), { recursive: true });
    await writeFile(`${copy}.db`, "copy");
    await applyPersistStorage({
      project_id: PROJECT,
      actions: [{ op: "delete", name: "acp-log/home/user/x.chat" }],
      env: withCopies,
    });
    // (else the persist server would copy it back)
    expect(existsSync(`${copy}.db`)).toBe(false);
  });

  it("refuses when the history is in the home, and too many actions", async () => {
    await expect(
      applyPersistStorage({
        project_id: PROJECT,
        actions: [{ op: "delete", name: "x" }],
        env: { COCALC_SYNC_PROJECTS: join(mount, "persist") },
      }),
    ).rejects.toThrow(/in its home/);
    await expect(
      applyPersistStorage({
        project_id: PROJECT,
        actions: Array.from({ length: 1001 }, () => ({
          op: "delete" as const,
          name: "x",
        })),
        env,
      }),
    ).rejects.toThrow(/at most 1000/);
    expect(
      await applyPersistStorage({ project_id: PROJECT, actions: [], env }),
    ).toEqual({ results: [], freed: 0 });
  });
});
