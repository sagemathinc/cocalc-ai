import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  before as beforeConat,
  after as afterConat,
  connect,
  once,
} from "@cocalc/backend/conat/test/setup";
import {
  createPathFileserver,
  cleanupFileservers,
} from "@cocalc/backend/conat/files/test/util";
import { uuid } from "@cocalc/util/misc";

let home: string;
let rootfs: string;
let fileserver: Awaited<ReturnType<typeof createPathFileserver>>;

beforeAll(async () => {
  await beforeConat();
  home = await mkdtemp(join(tmpdir(), "sync-doc-home-"));
  rootfs = await mkdtemp(join(tmpdir(), "sync-doc-rootfs-"));
  fileserver = await createPathFileserver({
    path: home,
    rootfs,
    unsafeMode: false,
  });
});

afterAll(async () => {
  await cleanupFileservers();
  await rm(home, { recursive: true, force: true });
  await rm(rootfs, { recursive: true, force: true });
  await afterConat();
});

describe("absolute rootfs syncstring open", () => {
  it("loads existing rootfs files instead of opening an empty document", async () => {
    const project_id = uuid();
    const client = connect();
    const fs = client.fs({
      project_id,
      service: fileserver.service,
    });
    const path = "/tmp/rootfs-open.txt";
    await fs.mkdir("/tmp", { recursive: true });
    await fs.writeFile(path, "hello from rootfs");

    const sync = client.sync.string({
      project_id,
      path,
      service: fileserver.service,
      firstReadLockTimeout: 1,
    });

    await once(sync, "ready");
    expect(sync.to_str()).toBe("hello from rootfs");
    expect(sync.versions().length).toBe(1);
    expect(await fs.readFile(path, "utf8")).toBe("hello from rootfs");
    await sync.close();
    client.close?.();
  });
});
