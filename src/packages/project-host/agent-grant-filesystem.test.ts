import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import type { Filesystem } from "@cocalc/conat/files/fs";
import { PROJECT_VIEWER_SENSITIVE_PATHS } from "@cocalc/util/project-access";
import { createAgentGrantFilesystem } from "./agent-grant-filesystem";
import getPort from "@cocalc/backend/get-port";
import { init } from "@cocalc/conat/core/server";
import { once } from "@cocalc/util/async-utils";
import { fsAgentGrantServer, fsClient } from "@cocalc/conat/files/fs";
import { cleanupSyncFsServicesForTests } from "@cocalc/backend/sandbox/sync-fs-service";
import { cleanupSandboxWatchersForTests } from "@cocalc/backend/sandbox/watch";
import { closeConatClientForTests } from "@cocalc/conat/client";
import { Client } from "@cocalc/conat/core/client";

let home: string;
let fs: Filesystem;
let mode: "read" | "read-write";
let active: boolean;
const authorize = jest.fn(async () => {
  if (!active) throw new Error("run ended or grant revoked");
  return { mode };
});
function grant(root = "docs") {
  return createAgentGrantFilesystem({
    fs,
    authorize,
    readPolicy: {
      rules: [
        { action: "include", path: root, match: "prefix" },
        ...PROJECT_VIEWER_SENSITIVE_PATHS.map((path) => ({
          action: "exclude" as const,
          path,
          match: "prefix" as const,
        })),
      ],
    },
  });
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "file-grant-write-"));
  await mkdir(join(home, "docs"));
  await mkdir(join(home, "private"));
  await writeFile(join(home, "private/secret"), "secret");
  fs = new SandboxedFilesystem(home) as unknown as Filesystem;
  mode = "read-write";
  active = true;
  authorize.mockClear();
});
afterEach(async () => {
  await fs.close?.();
  await rm(home, { recursive: true, force: true });
});
afterAll(async () => {
  cleanupSyncFsServicesForTests();
  await cleanupSandboxWatchersForTests();
  closeConatClientForTests();
});

test("real filesystem create, overwrite, copy, rename, mkdir and remove", async () => {
  const api = grant();
  await api.mkdir("docs/nested/deep", { recursive: true });
  await api.writeFile("docs/nested/deep/a", Buffer.from("one"));
  await api.writeFile("docs/nested/deep/a", "two");
  await api.copyFile("docs/nested/deep/a", "docs/b");
  await api.rename("docs/b", "docs/c");
  expect(await readFile(join(home, "docs/c"), "utf8")).toBe("two");
  await api.rm("docs/nested", { recursive: true });
  await api.rm("docs/c");
  expect(await fs.exists("docs/c")).toBe(false);
});

test("real Conat clients write binary files and observe downgrade/revocation on cached services", async () => {
  const testMode = process.env.COCALC_TEST_MODE;
  process.env.COCALC_TEST_MODE = "1";
  const broker = init({
    port: await getPort(),
    systemAccountPassword: "test-file-grants",
  });
  if (broker.state !== "ready") await once(broker, "ready");
  const serving = broker.client({ noCache: true });
  const calling = broker.client({ noCache: true });
  const service = await fsAgentGrantServer({
    service: "fs-agent",
    client: serving,
    fs: async () => grant(),
  });
  try {
    const remote = fsClient({
      client: calling,
      subject: "fs-agent.fixture",
      timeout: 3000,
    });
    const data = Buffer.from([0, 1, 128, 255]);
    await remote.mkdir("docs/remote");
    await remote.writeFile("docs/remote/a", data);
    expect(Buffer.from(await remote.readFile("docs/remote/a"))).toEqual(data);
    await remote.copyFile("docs/remote/a", "docs/remote/b");
    await remote.rename("docs/remote/b", "docs/remote/c");
    mode = "read";
    await expect(
      remote.rm("docs/remote", { recursive: true }),
    ).rejects.toThrow();
    expect(Buffer.from(await remote.readFile("docs/remote/c"))).toEqual(data);
    mode = "read-write";
    await remote.rm("docs/remote", { recursive: true });
    active = false;
    await expect(remote.writeFile("docs/new", "denied")).rejects.toThrow();
  } finally {
    service.close();
    calling.close();
    serving.close();
    await broker.close();
    Client.closeAllForTests();
    if (testMode == null) delete process.env.COCALC_TEST_MODE;
    else process.env.COCALC_TEST_MODE = testMode;
  }
}, 20_000);

test.each(["writeFile", "mkdir", "rename", "copyFile", "rm"])(
  "read-only and downgraded connections reject %s",
  async (method) => {
    const api = grant();
    await api.writeFile("docs/a", "one");
    mode = "read";
    await expect(
      (api as any)[method](
        "docs/a",
        method === "writeFile"
          ? "two"
          : method === "rename" || method === "copyFile"
            ? "docs/b"
            : undefined,
      ),
    ).rejects.toThrow("EACCES");
    expect(await api.readFile("docs/a", "utf8")).toBe("one");
  },
);

test("ended/revoked run rejects mutations and reads on an existing adapter", async () => {
  const api = grant();
  await api.writeFile("docs/a", "one");
  active = false;
  await expect(api.writeFile("docs/a", "two")).rejects.toThrow("run ended");
  await expect(api.readFile("docs/a")).rejects.toThrow("run ended");
});

test("confines new destinations and both paths of copy and rename", async () => {
  const api = grant();
  await api.writeFile("docs/a", "one");
  for (const path of [
    "private/new",
    "docs/../private/new",
    "/tmp/outside",
    "docs-other/new",
  ]) {
    await expect(api.writeFile(path, "bad")).rejects.toThrow();
    await expect(api.rename("docs/a", path)).rejects.toThrow();
    await expect(api.copyFile("docs/a", path)).rejects.toThrow();
  }
  await expect(api.copyFile("private/secret", "docs/stolen")).rejects.toThrow();
  await expect(api.rename("private/secret", "docs/stolen")).rejects.toThrow();
  expect(await fs.exists("docs/a")).toBe(true);
});

test("whole-project mutations preserve excluded namespaces and their ancestors", async () => {
  const api = grant(".");
  for (const path of PROJECT_VIEWER_SENSITIVE_PATHS) {
    await mkdir(join(home, path), { recursive: true });
    await expect(api.writeFile(`${path}/new`, "bad")).rejects.toThrow();
    await expect(api.rm(path, { recursive: true })).rejects.toThrow();
  }
  await expect(api.rm(".", { recursive: true })).rejects.toThrow();
  await expect(api.rm(".local", { recursive: true })).rejects.toThrow();
  await expect(api.rename(".local", "old-local")).rejects.toThrow();
  await expect(api.rename("docs", ".local")).rejects.toThrow();
});

test("rejects existing and dangling symlinks, including parent components", async () => {
  await symlink("../private", join(home, "docs/link"));
  await symlink("../private/missing", join(home, "docs/dangling"));
  const api = grant();
  await expect(api.writeFile("docs/link/new", "bad")).rejects.toThrow();
  await expect(api.writeFile("docs/dangling", "bad")).rejects.toThrow();
  await expect(api.rm("docs/link", { recursive: true })).rejects.toThrow();
  expect(await fs.exists("private/missing")).toBe(false);
});

test("narrow roots cannot create parents outside their grant; no backups or sudo", async () => {
  await expect(
    grant("missing/allowed").mkdir("missing/allowed", { recursive: true }),
  ).rejects.toThrow();
  await expect(grant().writeFile("docs/a", "one", true)).rejects.toThrow();
  await expect(grant().rm("docs/a", { sudo: true })).rejects.toThrow();
  expect(grant().symlink).toBeUndefined();
  expect(grant().link).toBeUndefined();
  expect(grant().ouch).toBeUndefined();
});
