// mount() itself: a rootfs in use is never detached from under its users.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = "11111111-2222-4333-8444-555555555555";
const P = 1073741824;
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
const DELAY_MS = 20;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// fails (instead of hanging) if p doesn't settle: a deadlock
const settles = <T>(p: Promise<T>, ms = 2000) =>
  Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error("did not settle: deadlock");
    }),
  ]);
// a mount table that follows the helper's mounts and unmounts
function trackMounts(initial: string[] = []) {
  const mounted = new Set<string>(initial);
  const sync = () => {
    mockMountinfo = [...mounted].map(line).join("\n");
  };
  sync();
  mockExecuteCode.mockImplementation(async (opts: any) => {
    const args: string[] = opts.args ?? [];
    if (args.includes("mount-overlay-project")) mounted.add(args.at(-1)!);
    if (args.includes("umount-overlay-project")) mounted.delete(args.at(-1)!);
    sync();
    return { stdout: "" };
  });
  return mounted;
}
const line = (mountpoint: string) =>
  `700 22 0:90 / ${mountpoint} rw,relatime shared:9 - overlay overlay rw`;
const helperCalls = (verb: string) =>
  mockExecuteCode.mock.calls.filter(([opts]) => opts.args?.includes(verb));

describe("mount() with a rootfs that is already mounted", () => {
  let dir: string;
  let home: string;

  beforeEach(async () => {
    jest.resetModules();
    mockExecuteCode.mockClear();
    mockMountinfo = "";
    dir = await mkdtemp(join(tmpdir(), "rootfs-mount-"));
    home = join(dir, "home");
    process.env.COCALC_PROJECT_ROOTS = join(dir, "roots");
    // the real lease manager, with a short delayed disposal
    process.env.COCALC_SANDBOX_UNMOUNT_DELAY_MS = `${DELAY_MS}`;
  });

  afterEach(async () => {
    delete process.env.COCALC_PROJECT_ROOTS;
    delete process.env.COCALC_SANDBOX_UNMOUNT_DELAY_MS;
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a plain request while the project holds its idmapped rootfs, and detaches nothing", async () => {
    const { mount } = await import("./rootfs");
    // the project's start mounts it idmapped and keeps its lease
    expect(await mount({ project_id: PROJECT, home, idmapUid: P })).toBe(
      IDMAPPED,
    );
    expect(helperCalls("mount-overlay-project")).toHaveLength(1);
    mockMountinfo = line(IDMAPPED);

    // a sidecar asks for the plain rootfs
    await expect(mount({ project_id: PROJECT, home })).rejects.toThrow(
      "is mounted for the other runtime uid mode and may still be in use",
    );
    expect(helperCalls("umount-overlay-project")).toHaveLength(0);
    expect(helperCalls("mount-overlay-project")).toHaveLength(1);

    // control: the same request the project made is reused
    expect(await mount({ project_id: PROJECT, home, idmapUid: P })).toBe(
      IDMAPPED,
    );
    expect(helperCalls("mount-overlay-project")).toHaveLength(1);
  });

  it("refuses after a daemon restart (no leases known) unless the start proves the rootfs unused", async () => {
    const { mount } = await import("./rootfs");
    // a previous daemon mounted it idmapped; this one holds nothing
    mockMountinfo = line(IDMAPPED);

    await expect(mount({ project_id: PROJECT, home })).rejects.toThrow(
      "may still be in use",
    );
    await expect(
      mount({ project_id: PROJECT, home, proveUnused: async () => false }),
    ).rejects.toThrow("may still be in use");
    await expect(
      mount({
        project_id: PROJECT,
        home,
        proveUnused: async () => {
          throw new Error("podman failed");
        },
      }),
    ).rejects.toThrow("may still be in use");
    expect(helperCalls("umount-overlay-project")).toHaveLength(0);

    // the refusals left nothing that disposes of the mount later
    await sleep(3 * DELAY_MS);
    expect(helperCalls("umount-overlay-project")).toHaveLength(0);

    // the start, having found none of the project's containers alive
    const merged = await mount({
      project_id: PROJECT,
      home,
      proveUnused: async () => true,
    });
    expect(merged).toBe(join(dir, "roots", PROJECT));
    expect(helperCalls("umount-overlay-project")).toEqual([
      [expect.objectContaining({ args: expect.arrayContaining([IDMAPPED]) })],
    ]);
    expect(helperCalls("mount-overlay-project")).toHaveLength(1);
  });

  it("decides, proves, detaches and mounts under one lock: a competing mount can't slip in", async () => {
    const { mount, getImageNamePath } = await import("./rootfs");
    // the mount table follows the helper's mounts and unmounts
    const mounted = new Set<string>();
    const sync = () => {
      mockMountinfo = [...mounted].map(line).join("\n");
    };
    mockExecuteCode.mockImplementation(async (opts: any) => {
      const args: string[] = opts.args ?? [];
      if (args.includes("mount-overlay-project")) mounted.add(args.at(-1)!);
      if (args.includes("umount-overlay-project")) mounted.delete(args.at(-1)!);
      sync();
      return { stdout: "" };
    });
    // a previous daemon mounted it plain, with this image
    const plainPath = join(dir, "roots", PROJECT);
    mounted.add(plainPath);
    sync();
    const imageName = getImageNamePath(home);
    await mkdir(dirname(imageName), { recursive: true });
    await writeFile(imageName, "image-a");

    // the start wants it idmapped; its proof is held open
    let proven!: (value: boolean) => void;
    const proof = new Promise<boolean>((resolve) => (proven = resolve));
    let proving!: () => void;
    const proofAsked = new Promise<void>((resolve) => (proving = resolve));
    const start = mount({
      project_id: PROJECT,
      home,
      idmapUid: P,
      proveUnused: async () => {
        proving();
        return await proof;
      },
    });
    await proofAsked;
    // meanwhile a sidecar asks for the plain rootfs that is mounted now
    const sidecar = mount({ project_id: PROJECT, home });
    const sidecarDone = sidecar.then(
      () => "mounted",
      (err) => `${err}`,
    );
    // it must not get the old mount while the start is deciding
    await new Promise((resolve) => setTimeout(resolve, 50));
    proven(true);
    expect(await start).toBe(IDMAPPED);
    expect(await sidecarDone).toContain(
      "is mounted for the other runtime uid mode",
    );
    expect([...mounted]).toEqual([IDMAPPED]);
    expect(helperCalls("umount-overlay-project")).toHaveLength(1);
  });

  it("doesn't deadlock when a delayed disposal fires while a mount holds the lock", async () => {
    const { mount, unmount } = await import("./rootfs");
    const base = jest.requireMock("./rootfs-base");
    const plainPath = join(dir, "roots", PROJECT);
    const mounted = trackMounts();
    await mount({ project_id: PROJECT, home });
    await unmount(PROJECT); // count 0: the delayed disposal is scheduled
    // the next mount holds the rootfs lock while the image is extracted...
    let extracted!: () => void;
    base.extractBaseImage.mockImplementationOnce(
      () => new Promise((resolve) => (extracted = () => resolve("/lower"))),
    );
    const next = mount({ project_id: PROJECT, home });
    // ...while the disposal timer fires
    await sleep(3 * DELAY_MS);
    extracted();
    expect(await settles(next)).toBe(plainPath);
    await sleep(3 * DELAY_MS);
    // the queued disposal saw the new holder and left the mount alone
    expect([...mounted]).toEqual([plainPath]);
    expect(helperCalls("umount-overlay-project")).toHaveLength(0);
  });

  it("doesn't deadlock when a stop's immediate release races a mount", async () => {
    const { mount, unmountAll } = await import("./rootfs");
    trackMounts();
    await mount({ project_id: PROJECT, home });
    const stop = unmountAll(PROJECT, { immediate: true });
    const again = mount({ project_id: PROJECT, home });
    await settles(Promise.all([stop, again]));
  });

  it("takes leftovers down only with nothing holding them and a proof, all under the lock", async () => {
    const { mount, detachLeftovers } = await import("./rootfs");
    const plainPath = join(dir, "roots", PROJECT);
    const mounted = trackMounts([IDMAPPED]);
    const views = jest.fn(async () => {});

    // a failed or missing proof is no proof
    for (const proveUnused of [
      async () => false,
      async () => {
        throw new Error("podman failed");
      },
    ]) {
      await expect(
        detachLeftovers(PROJECT, { proveUnused, alsoDetach: views }),
      ).rejects.toThrow("may still be in use");
    }
    expect(views).not.toHaveBeenCalled();
    expect(helperCalls("umount-overlay-project")).toHaveLength(0);

    // a sidecar mounting during the proof waits, then mounts afresh
    let proven!: (value: boolean) => void;
    let proving!: () => void;
    const asked = new Promise<void>((resolve) => (proving = resolve));
    const cleanup = detachLeftovers(PROJECT, {
      proveUnused: async () => {
        proving();
        return await new Promise<boolean>((resolve) => (proven = resolve));
      },
      alsoDetach: views,
    });
    await asked;
    const sidecar = mount({ project_id: PROJECT, home });
    await sleep(3 * DELAY_MS);
    // it hasn't taken (or been given) the leftover meanwhile
    expect(helperCalls("mount-overlay-project")).toHaveLength(0);
    proven(true);
    await settles(cleanup);
    expect(await settles(sidecar)).toBe(plainPath);
    expect(views).toHaveBeenCalledTimes(1);
    expect([...mounted]).toEqual([plainPath]);

    // with the sidecar holding its rootfs, no cleanup, and no proof asked
    const proof = jest.fn(async () => true);
    await expect(
      detachLeftovers(PROJECT, { proveUnused: proof, alsoDetach: views }),
    ).rejects.toThrow("may still be in use");
    expect(proof).not.toHaveBeenCalled();
    expect([...mounted]).toEqual([plainPath]);
  });

  it("refuses another image while the rootfs is held", async () => {
    const { mount } = await import("./rootfs");
    const plainPath = join(dir, "roots", PROJECT);
    await mount({
      project_id: PROJECT,
      home,
      config: { image: "image-a" } as any,
    });
    mockMountinfo = line(plainPath);
    await expect(
      mount({
        project_id: PROJECT,
        home,
        config: { image: "image-b" } as any,
        proveUnused: async () => true,
      }),
    ).rejects.toThrow("is mounted with another image");
    expect(helperCalls("umount-overlay-project")).toHaveLength(0);
  });
});
