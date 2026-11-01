jest.mock("@cocalc/backend/sandbox/rustic", () => ({
  __esModule: true,
  default: jest.fn(),
}));

import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rustic from "@cocalc/backend/sandbox/rustic";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, jest } from "@jest/globals";

import {
  __test__,
  parseDavEntries,
  repositoryIdentityFromProfile,
  RusticBackupBrowserManager,
  RusticFindOutputParser,
  RusticWebDavClient,
} from "./rustic-backup-browser";

function response({
  href,
  directory = false,
  size = 0,
  mtime = "Mon, 10 Aug 2026 05:10:36 GMT",
}: {
  href: string;
  directory?: boolean;
  size?: number;
  mtime?: string;
}): string {
  return [
    "<D:response>",
    `<D:href>${href}</D:href>`,
    "<D:propstat><D:prop>",
    directory ? "" : `<D:getcontentlength>${size}</D:getcontentlength>`,
    `<D:getlastmodified>${mtime}</D:getlastmodified>`,
    directory
      ? "<D:resourcetype><D:collection></D:collection></D:resourcetype>"
      : "<D:resourcetype></D:resourcetype>",
    "</D:prop></D:propstat>",
    "</D:response>",
  ].join("");
}

function multistatus(...responses: string[]): string {
  return `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`;
}

describe("Rustic backup browser metadata", () => {
  it("derives repository identity without credentials", () => {
    const first = `
[repository]
repository = "opendal:s3"
password = "first-password"

[repository.options]
endpoint = "https://example.invalid"
bucket = "backups"
root = "shared-0001"
access_key_id = "first-access"
secret_access_key = "first-secret"
`;
    const rotated = first
      .replace("first-password", "rotated-password")
      .replace("first-access", "rotated-access")
      .replace("first-secret", "rotated-secret");
    expect(repositoryIdentityFromProfile(first)).toBe(
      repositoryIdentityFromProfile(rotated),
    );
    expect(repositoryIdentityFromProfile(first)).not.toContain("first-secret");
  });

  it("parses DAV metadata and decodes paths", () => {
    const entries = parseDavEntries(
      multistatus(
        response({ href: "/root/", directory: true }),
        response({ href: "/root/a%20file.txt", size: 42 }),
      ),
    );
    expect(entries).toEqual([
      expect.objectContaining({ pathname: "/root/", isDir: true, size: 0 }),
      expect.objectContaining({
        pathname: "/root/a file.txt",
        isDir: false,
        size: 42,
        mtime: Date.parse("Mon, 10 Aug 2026 05:10:36 GMT"),
      }),
    ]);
  });

  it("parses stable snapshot paths", () => {
    expect(
      __test__.parseSnapshotSegment(
        "20260810T053214+0000--SnapshotId(85b85e9688da026e4951c68d01b6edaac83068e3c85470f0728ec932272bf9b9)",
      ),
    ).toEqual(
      expect.objectContaining({
        id: "85b85e9688da026e4951c68d01b6edaac83068e3c85470f0728ec932272bf9b9",
        time: new Date("2026-08-10T05:32:14+00:00"),
      }),
    );
    expect(
      __test__.parseSnapshotSegment(
        "20260810T053214+0000--85b85e9688da026e4951c68d01b6edaac83068e3c85470f0728ec932272bf9b9",
      ),
    ).toEqual(
      expect.objectContaining({
        id: "85b85e9688da026e4951c68d01b6edaac83068e3c85470f0728ec932272bf9b9",
      }),
    );
  });

  it("parses native Rustic find groups and preserves changed metadata", () => {
    const first = {
      id: "a".repeat(64),
      time: new Date("2026-08-01T00:00:00Z"),
      summary: {},
    };
    const second = {
      id: "b".repeat(64),
      time: new Date("2026-08-02T00:00:00Z"),
      summary: {},
    };
    const third = {
      id: "c".repeat(64),
      time: new Date("2026-08-03T00:00:00Z"),
      summary: {},
    };
    const parser = new RusticFindOutputParser([first, second, third]);
    parser.push(
      Buffer.from(
        [
          "searching in snapshots group (...)...",
          `found in ${first.id.slice(0, 8)} from 2026-08-01 00:00:00+0000`,
          '-rw-r--r-- user group        49 23 Jul 2026 16:23 "docs/a file.txt" ',
          `found in ${second.id.slice(0, 8)} from 2026-08-02 00:00:00+0000`,
          `found in ${third.id.slice(0, 8)} from 2026-08-03 00:00:00+0000`,
          '-rw-r--r-- user group        72 24 Jul 2026 17:24 "docs/a file.txt" ',
          "",
        ].join("\n"),
      ),
    );
    expect(parser.finish()).toEqual([
      expect.objectContaining({
        id: first.id,
        path: "docs/a file.txt",
        size: 49,
        mtime: Date.UTC(2026, 6, 23, 16, 23),
      }),
      expect.objectContaining({
        id: second.id,
        path: "docs/a file.txt",
        size: 72,
      }),
      expect.objectContaining({
        id: third.id,
        path: "docs/a file.txt",
        size: 72,
      }),
    ]);
  });

  it("stops a parser before retaining more than its result limit", () => {
    const snapshot = {
      id: "f".repeat(64),
      time: new Date("2026-08-01T00:00:00Z"),
      summary: {},
    };
    const parser = new RusticFindOutputParser([snapshot], undefined, 1);
    expect(() =>
      parser.push(
        Buffer.from(
          [
            `found in ${snapshot.id.slice(0, 8)} from 2026-08-01 00:00:00+0000`,
            '-rw-r--r-- user group         1 10 Aug 2026 05:10 "first.pdf" ',
            '-rw-r--r-- user group         2 10 Aug 2026 05:10 "second.pdf" ',
            "",
          ].join("\n"),
        ),
      ),
    ).toThrow("results limit");
    expect(parser.results).toEqual([
      expect.objectContaining({ path: "first.pdf" }),
    ]);
  });

  it("uses Rustic exact-path lookup when the glob has no metacharacters", () => {
    const snapshots = [
      {
        id: "d".repeat(64),
        time: new Date("2026-08-01T00:00:00Z"),
        summary: {},
      },
    ];
    expect(
      __test__.rusticFindArgs({
        profilePath: "/tmp/repo.toml",
        snapshots,
        glob: ["docs/file.tex"],
      }),
    ).toContain("--path=docs/file.tex");
    expect(
      __test__.rusticFindArgs({
        profilePath: "/tmp/repo.toml",
        snapshots,
        iglob: ["*file*"],
      }),
    ).toContain("--iglob=*file*");
  });

  it("parses directories and symlinks from Rustic find output", () => {
    expect(
      __test__.parseRusticFindEntry(
        'drwxr-xr-x user group         0 10 Aug 2026 05:10 "docs" ',
      ),
    ).toEqual(expect.objectContaining({ path: "docs", isDir: true, size: 0 }));
    expect(
      __test__.parseRusticFindEntry(
        'lrwxrwxrwx user group        15 10 Aug 2026 05:10 "latest notes" -> docs/notes.txt',
      ),
    ).toEqual(
      expect.objectContaining({
        path: "latest notes",
        isDir: false,
        size: 15,
      }),
    );
  });
});

describe("RusticWebDavClient", () => {
  let server: Server | undefined;

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server = undefined;
      }),
  );

  it("lists snapshots and browses directories", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const host = `project-${projectId}`;
    const id = "a".repeat(64);
    const segment = `20260810T053214+0000--SnapshotId(${id})`;
    const snapshotRoot = `/${host}/${encodeURIComponent(segment)}/`;
    const responses = new Map<string, string>([
      [
        `/${host}/`,
        multistatus(
          response({ href: `/${host}/`, directory: true }),
          response({
            href: snapshotRoot,
            directory: true,
          }),
          response({ href: `/${host}/latest/`, directory: true }),
        ),
      ],
      [
        snapshotRoot,
        multistatus(
          response({ href: snapshotRoot, directory: true }),
          response({ href: `${snapshotRoot}docs/`, directory: true }),
          response({ href: `${snapshotRoot}hello%20world.txt`, size: 12 }),
        ),
      ],
      [
        `${snapshotRoot}docs/`,
        multistatus(
          response({ href: `${snapshotRoot}docs/`, directory: true }),
          response({ href: `${snapshotRoot}docs/guide.md`, size: 99 }),
        ),
      ],
    ]);
    server = createServer((req, res) => {
      const body = responses.get(req.url ?? "");
      if (!body) {
        res.statusCode = 404;
        res.end("missing");
        return;
      }
      res.statusCode = 207;
      res.setHeader("content-type", "application/xml");
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const client = new RusticWebDavClient(`http://127.0.0.1:${address.port}`);

    expect(await client.listBackups(projectId)).toEqual([
      expect.objectContaining({ id, time: new Date("2026-08-10T05:32:14Z") }),
    ]);
    expect(await client.listDirectory({ projectId, id })).toEqual([
      expect.objectContaining({ name: "docs", isDir: true }),
      expect.objectContaining({
        name: "hello world.txt",
        isDir: false,
        size: 12,
      }),
    ]);
    expect(
      await client.getEntry({ projectId, id, path: "docs/guide.md" }),
    ).toEqual(expect.objectContaining({ name: "guide.md", size: 99 }));
  });

  it("searches every current backup directory before optional descent", async () => {
    const projectId = "22222222-2222-4222-8222-222222222222";
    const host = `project-${projectId}`;
    const oldId = "a".repeat(64);
    const newId = "b".repeat(64);
    const oldSegment = `20260809T053214+0000--SnapshotId(${oldId})`;
    const newSegment = `20260810T053214+0000--SnapshotId(${newId})`;
    const oldRoot = `/${host}/${encodeURIComponent(oldSegment)}/`;
    const newRoot = `/${host}/${encodeURIComponent(newSegment)}/`;
    const requests: string[] = [];
    const responses = new Map<string, string>([
      [
        `/${host}/`,
        multistatus(
          response({ href: `/${host}/`, directory: true }),
          response({ href: oldRoot, directory: true }),
          response({ href: newRoot, directory: true }),
        ),
      ],
      [
        oldRoot,
        multistatus(
          response({ href: oldRoot, directory: true }),
          response({ href: `${oldRoot}docs/`, directory: true }),
          response({ href: `${oldRoot}old.pdf`, size: 10 }),
        ),
      ],
      [
        newRoot,
        multistatus(
          response({ href: newRoot, directory: true }),
          response({ href: `${newRoot}docs/`, directory: true }),
          response({ href: `${newRoot}new.pdf`, size: 20 }),
        ),
      ],
      [
        `${oldRoot}docs/`,
        multistatus(
          response({ href: `${oldRoot}docs/`, directory: true }),
          response({ href: `${oldRoot}docs/guide.pdf`, size: 30 }),
        ),
      ],
      [
        `${newRoot}docs/`,
        multistatus(
          response({ href: `${newRoot}docs/`, directory: true }),
          response({ href: `${newRoot}docs/guide.pdf`, size: 40 }),
        ),
      ],
    ]);
    server = createServer((req, res) => {
      requests.push(req.url ?? "");
      const body = responses.get(req.url ?? "");
      if (!body) {
        res.statusCode = 404;
        res.end("missing");
        return;
      }
      res.statusCode = 207;
      res.setHeader("content-type", "application/xml");
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const client = new RusticWebDavClient(`http://127.0.0.1:${address.port}`);
    const snapshots = (await client.listBackups(projectId)).sort(
      (a, b) => b.time.getTime() - a.time.getTime(),
    );

    await expect(
      __test__.findDirectoryPreview({
        client,
        projectId,
        snapshots,
        iglob: ["*pdf*"],
        recursive: false,
      }),
    ).resolves.toMatchObject({
      truncated: false,
      results: [
        expect.objectContaining({ id: newId, path: "new.pdf" }),
        expect.objectContaining({ id: oldId, path: "old.pdf" }),
      ],
    });
    expect(requests).not.toContain(`${newRoot}docs/`);
    expect(requests).not.toContain(`${oldRoot}docs/`);

    const recursive = await __test__.findDirectoryPreview({
      client,
      projectId,
      snapshots,
      iglob: ["*guide*"],
      recursive: true,
    });
    expect(recursive).toMatchObject({
      truncated: false,
      results: [
        expect.objectContaining({ id: newId, path: "docs/guide.pdf" }),
        expect.objectContaining({ id: oldId, path: "docs/guide.pdf" }),
      ],
    });
    const firstNested = Math.min(
      requests.indexOf(`${newRoot}docs/`),
      requests.indexOf(`${oldRoot}docs/`),
    );
    expect(requests.indexOf(newRoot)).toBeLessThan(firstNested);
    expect(requests.indexOf(oldRoot)).toBeLessThan(firstNested);
  });

  it("caps directory search previews at 100 results", async () => {
    const projectId = "33333333-3333-4333-8333-333333333333";
    const host = `project-${projectId}`;
    const id = "c".repeat(64);
    const segment = `20260810T053214+0000--SnapshotId(${id})`;
    const snapshotRoot = `/${host}/${encodeURIComponent(segment)}/`;
    const responses = new Map<string, string>([
      [
        `/${host}/`,
        multistatus(
          response({ href: `/${host}/`, directory: true }),
          response({ href: snapshotRoot, directory: true }),
        ),
      ],
      [
        snapshotRoot,
        multistatus(
          response({ href: snapshotRoot, directory: true }),
          ...Array.from({ length: 101 }, (_, index) =>
            response({ href: `${snapshotRoot}file-${index}.pdf`, size: index }),
          ),
        ),
      ],
    ]);
    server = createServer((req, res) => {
      const body = responses.get(req.url ?? "");
      if (!body) {
        res.statusCode = 404;
        res.end("missing");
        return;
      }
      res.statusCode = 207;
      res.setHeader("content-type", "application/xml");
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const client = new RusticWebDavClient(`http://127.0.0.1:${address.port}`);
    const snapshots = await client.listBackups(projectId);

    const result = await __test__.findDirectoryPreview({
      client,
      projectId,
      snapshots,
      iglob: ["*pdf*"],
    });
    expect(result.results).toHaveLength(100);
    expect(result).toMatchObject({
      truncated: true,
      truncationReason: "results",
    });
  });
});

describe("native snapshot listing", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const older = {
    id: "a".repeat(64),
    hostname: `project-${projectId}`,
    time: "2026-08-10T05:32:14Z",
  };
  const newer = { ...older, id: "b".repeat(64), time: "2026-08-11T05:32:14Z" };
  const run = jest.mocked(rustic);
  let directory: string | undefined;
  let manager: RusticBackupBrowserManager | undefined;

  afterEach(async () => {
    manager?.close();
    manager = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
    run.mockReset();
  });

  async function profile(): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), "backup-list-"));
    const profilePath = join(directory, "repo.toml");
    await writeFile(
      profilePath,
      '[repository]\nrepository = "/synthetic/repo"\n',
    );
    return profilePath;
  }

  function output(snapshots = [newer, older]) {
    return {
      code: 0,
      stdout: JSON.stringify([{ snapshots }]),
      stderr: "",
      truncated: false,
    };
  }

  it("returns oldest-first full IDs from snapshot JSON without starting WebDAV", async () => {
    const start = jest.fn(async () => {
      throw Error("browser must not start");
    });
    manager = new RusticBackupBrowserManager({ start, idleSweep: false });
    run.mockResolvedValue(output());
    const backups = await manager.listBackups({
      profilePath: await profile(),
      projectId,
    });
    expect(backups).toEqual(
      [older, newer].map(({ id, time }) => ({
        id,
        time: new Date(time),
        summary: {},
      })),
    );
    expect(start).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      ["snapshots", "--json"],
      expect.objectContaining({
        host: older.hostname,
        timeout: expect.any(Number),
      }),
    );
    expect(run.mock.calls[0][1].timeout).toBeGreaterThan(0);
    expect(run.mock.calls[0][1].timeout).toBeLessThanOrEqual(20_000);
    // The browser's timestamp/long_id path template resolves the same IDs
    // supplied directly to restore (including Rustic's wrapped ID spelling).
    for (const backup of backups) {
      const date = backup.time.toISOString().replace(/[-:]/g, "").slice(0, 15);
      for (const id of [backup.id, `SnapshotId(${backup.id})`]) {
        expect(__test__.parseSnapshotSegment(`${date}+0000--${id}`)?.id).toBe(
          backup.id,
        );
      }
    }
  });

  it("sees new snapshots after markStale even when no browser was started", async () => {
    const start = jest.fn(async () => {
      throw Error("browser must not start");
    });
    manager = new RusticBackupBrowserManager({ start, idleSweep: false });
    const profilePath = await profile();
    run.mockResolvedValueOnce(output([older])).mockResolvedValueOnce(output());
    expect(await manager.listBackups({ profilePath, projectId })).toHaveLength(
      1,
    );
    await manager.markStale(profilePath);
    expect(await manager.listBackups({ profilePath, projectId })).toHaveLength(
      2,
    );
    expect(start).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports a bounded inventory failure without falling back to WebDAV", async () => {
    const start = jest.fn(async () => {
      throw Error("browser must not start");
    });
    manager = new RusticBackupBrowserManager({ start, idleSweep: false });
    run.mockResolvedValue({ ...output(), code: 1, truncated: true });
    await expect(
      manager.listBackups({ profilePath: await profile(), projectId }),
    ).rejects.toThrow("inventory exceeded its time or output limit");
    expect(start).not.toHaveBeenCalled();
  });

  it("still starts the browser for file browsing with an ID from the native list", async () => {
    const listDirectory = jest.fn(async (_args: unknown) => [
      { name: "course.txt", isDir: false, mtime: 1, size: 42 },
    ]);
    const start = jest.fn(async (descriptor: any) => ({
      descriptor,
      child: { exitCode: 0, kill: jest.fn() } as unknown as ChildProcess,
      client: { listDirectory } as unknown as RusticWebDavClient,
      startedAt: Date.now(),
      log: () => "",
    }));
    manager = new RusticBackupBrowserManager({ start, idleSweep: false });
    const profilePath = await profile();
    run.mockResolvedValue(output([older]));
    const [backup] = await manager.listBackups({ profilePath, projectId });
    expect(start).not.toHaveBeenCalled();
    expect(
      await manager.listDirectory({
        profilePath,
        projectId,
        id: backup.id,
        path: "docs",
      }),
    ).toHaveLength(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(listDirectory).toHaveBeenCalledWith({
      projectId,
      id: older.id,
      path: "docs",
    });
  });
});
