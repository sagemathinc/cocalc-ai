// Holders of a project's separate runtime (R1 PR3a plan §1a), with the real
// lease manager, a recorded mount table and recorded view operations.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = "11111111-2222-4333-8444-555555555555";
const P = 1073741824;
const DELAY_MS = 20;
let mockMountinfo = "";
const mockExecuteCode = jest.fn(async (_opts: any) => ({ stdout: "" }));

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return { __esModule: true, default: factory, getLogger: factory };
});
jest.mock("./conat-client", () => ({ getConatClient: jest.fn() }));
jest.mock("@cocalc/conat/lro/progress", () => ({ lroProgress: jest.fn() }));
jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: (opts: any) => mockExecuteCode(opts),
}));
jest.mock("./podman", () => ({
  getImage: (config?: { image?: string }) => config?.image ?? "image-a",
}));
jest.mock("./rootfs-base", () => ({
  extractBaseImage: jest.fn(async () => "/lower"),
  imageCachePath: (image: string) => `/cache/${image}`,
  imagePathComponent: (image: string) => image,
  registerProgress: jest.fn(),
}));
jest.mock("fs/promises", () => {
  const actual = jest.requireActual("fs/promises");
  return {
    ...actual,
    readFile: async (path: any, ...rest: any[]) =>
      path === "/proc/self/mountinfo"
        ? mockMountinfo
        : await actual.readFile(path, ...rest),
  };
});

const IDMAPPED = `/run/cocalc/project-rootfs/${PROJECT}/root`;
const line = (mountpoint: string) =>
  `700 22 0:90 / ${mountpoint} rw,relatime shared:9 - overlay overlay rw`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("separate runtime holders", () => {
  let dir: string;
  let home: string;
  let mounted: Set<string>;
  let events: string[];
  let views: Set<string>;
  let failUmount = false;

  const viewOps = () => ({
    mount: async ({ kind }: { kind: string }) => {
      if (views.has(kind)) throw new Error("project view is already mounted");
      views.add(kind);
      events.push(`mount-view ${kind}`);
      return `/run/cocalc/project-views/${PROJECT}/${kind}`;
    },
    mounted: async (_id: string, kind: string) => views.has(kind),
    umountAll: async () => {
      events.push("umount-views");
      views.clear();
    },
    anyMounted: async () => views.size > 0,
  });

  beforeEach(async () => {
    jest.resetModules();
    dir = await mkdtemp(join(tmpdir(), "separate-runtime-"));
    home = join(dir, "home");
    process.env.COCALC_PROJECT_ROOTS = join(dir, "roots");
    process.env.COCALC_SANDBOX_UNMOUNT_DELAY_MS = `${DELAY_MS}`;
    mounted = new Set();
    events = [];
    views = new Set();
    failUmount = false;
    const sync = () => {
      mockMountinfo = [...mounted].map(line).join("\n");
    };
    sync();
    mockExecuteCode.mockReset();
    mockExecuteCode.mockImplementation(async (opts: any) => {
      const args: string[] = opts.args ?? [];
      if (args.includes("mount-overlay-project")) {
        mounted.add(args.at(-1)!);
        events.push("mount-rootfs");
      }
      if (args.includes("umount-overlay-project")) {
        // every attempt counts, also one that finds nothing to unmount
        events.push("umount-attempt");
        // like the helper
        if (!mounted.has(args.at(-1)!)) throw new Error("not mounted");
        if (failUmount) throw new Error("target is busy");
        mounted.delete(args.at(-1)!);
        events.push("umount-rootfs");
      }
      sync();
      return { stdout: "" };
    });
  });

  afterEach(async () => {
    delete process.env.COCALC_PROJECT_ROOTS;
    delete process.env.COCALC_SANDBOX_UNMOUNT_DELAY_MS;
    await rm(dir, { recursive: true, force: true });
  });

  const acquire = async (holder: any, kinds = ["home", "scratch"]) => {
    const { acquireSeparateRuntime } = await import("./rootfs");
    return await acquireSeparateRuntime({
      project_id: PROJECT,
      home,
      idmapUid: P,
      kinds: kinds as any,
      holder,
      views: viewOps(),
    });
  };

  it("shares one rootfs and one set of views; the last holder detaches the rootfs, then the views", async () => {
    const rootfs = await import("./rootfs");
    const project = await acquire("project");
    const sandbox = await acquire("sandbox", ["home"]);
    expect(project.rootfs).toBe(IDMAPPED);
    expect(sandbox.views.home).toBe(project.views.home);
    expect(events).toEqual([
      "mount-rootfs",
      "mount-view home",
      "mount-view scratch",
    ]);
    expect(rootfs.separateRuntimeHolders(PROJECT)).toEqual({
      project: 1,
      sandbox: 1,
    });

    await project.release();
    expect(events).toHaveLength(3);
    expect([...mounted]).toEqual([IDMAPPED]);
    await sandbox.release();
    expect(events.slice(3)).toEqual([
      "umount-attempt",
      "umount-rootfs",
      "umount-views",
    ]);
    expect(rootfs.separateRuntimeHolders(PROJECT)).toEqual({});
    // its lease's delayed disposal finds nothing to do: not even an attempt
    await sleep(3 * DELAY_MS);
    expect(events.filter((e) => e === "umount-rootfs")).toHaveLength(1);
    expect(events.filter((e) => e === "umount-attempt")).toHaveLength(1);
    // releasing twice is a no-op
    await sandbox.release();
  });

  it("rejects when the last detach fails, and keeps the views (L1)", async () => {
    const holder = await acquire("project");
    failUmount = true;
    await expect(holder.release()).rejects.toThrow(
      "could not unmount this project's RootFS",
    );
    expect(events).not.toContain("umount-views");
    expect(views.size).toBe(2);
  });

  it("never lets an older queued disposal detach a holder acquired after the last release", async () => {
    const first = await acquire("project");
    await first.release();
    expect(events).toEqual([
      "mount-rootfs",
      "mount-view home",
      "mount-view scratch",
      "umount-attempt",
      "umount-rootfs",
      "umount-views",
    ]);
    // right away, before the released lease's disposal timer fires
    const next = await acquire("sandbox");
    await sleep(3 * DELAY_MS);
    expect([...mounted]).toEqual([IDMAPPED]);
    expect(views.size).toBe(2);
    expect(events.filter((e) => e === "umount-rootfs")).toHaveLength(1);
    await next.release();
  });

  it("reuses only views this daemon mounted, never a leftover found mounted (R-a)", async () => {
    // a previous daemon's view, still mounted: no record of it here
    views.add("home");
    await expect(acquire("sandbox", ["home"])).rejects.toThrow(
      "left over from an earlier run",
    );
    expect(events).not.toContain("mount-view home");
    // control: one this daemon mounted is reused, not mounted twice
    views.clear();
    const a = await acquire("project", ["home"]);
    const b = await acquire("sandbox", ["home"]);
    expect(events.filter((e) => e === "mount-view home")).toHaveLength(1);
    await b.release();
    await a.release();
  });

  it("refuses a new holder while the project's runtime is being stopped (R-d)", async () => {
    const rootfs = await import("./rootfs");
    rootfs.closeSeparateRuntime(PROJECT);
    await expect(acquire("sandbox")).rejects.toThrow("being stopped");
    expect(events).toEqual([]);
    rootfs.reopenSeparateRuntime(PROJECT);
    const holder = await acquire("sandbox");
    await holder.release();
  });

  it("gives the lease back when a view can't be mounted, counting nothing", async () => {
    const rootfs = await import("./rootfs");
    const { acquireSeparateRuntime } = rootfs;
    const ops = viewOps();
    await expect(
      acquireSeparateRuntime({
        project_id: PROJECT,
        home,
        idmapUid: P,
        kinds: ["home"],
        holder: "codex",
        views: {
          ...ops,
          mount: async () => {
            throw new Error("helper failed");
          },
        },
      }),
    ).rejects.toThrow("helper failed");
    expect(rootfs.separateRuntimeHolders(PROJECT)).toEqual({});
  });
});
