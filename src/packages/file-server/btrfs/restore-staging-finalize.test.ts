const existing = new Set<string>();
const moves: string[][] = [];
const forgotten: string[][] = [];
const btrfsCalls: string[][] = [];
const homeEntries = new Map<string, string[]>();
const warnings: any[][] = [];

jest.mock("@cocalc/backend/misc/async-utils-node", () => ({
  exists: jest.fn(async (path: string) => existing.has(path)),
}));
jest.mock("node:fs/promises", () => ({
  readdir: jest.fn(async (path: string) => homeEntries.get(path) ?? []),
  rm: jest.fn(async () => undefined),
  stat: jest.fn(async () => ({ mtimeMs: Date.now() })),
  writeFile: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: any[]) => warnings.push(args),
    error: jest.fn(),
  }),
}));
jest.mock("@cocalc/file-server/btrfs/util", () => ({
  btrfs: jest.fn(async ({ args }: { args: string[] }) => {
    btrfsCalls.push(args);
    return { stdout: "", stderr: "", exit_code: 0 };
  }),
  sudo: jest.fn(
    async ({ command, args }: { command: string; args: string[] }) => {
      if (command === "mv") {
        moves.push(args);
        existing.delete(args[0]);
        existing.add(args[1]);
        // the directory's contents move with it (so a decision made after
        // the swap reads the RESTORED home, not the old one)
        for (const [path, entries] of Array.from(homeEntries)) {
          if (path === args[0] || path.startsWith(`${args[0]}/`)) {
            homeEntries.delete(path);
            homeEntries.set(args[1] + path.slice(args[0].length), entries);
          }
        }
      }
      return { stdout: "", stderr: "", exit_code: 0 };
    },
  ),
}));
jest.mock("@cocalc/file-server/btrfs/subvolume", () => ({
  isBtrfsSubvolume: jest.fn(async () => true),
}));
jest.mock("@cocalc/file-server/btrfs/operation-cache", () => ({
  forgetSubvolumePaths: (...paths: string[]) => forgotten.push(paths),
}));

import { finalizeRestoreStaging } from "./restore-staging";

const home = "/mnt/cocalc/project-a";
const stagingPath = "/mnt/cocalc/.restore-staging/project-a";

beforeEach(() => {
  existing.clear();
  moves.length = 0;
  forgotten.length = 0;
  btrfsCalls.length = 0;
  homeEntries.clear();
  warnings.length = 0;
  existing.add(home);
  existing.add(stagingPath);
});

function deletedPaths(): string[] {
  return btrfsCalls
    .filter((args) => args[0] === "subvolume" && args[1] === "delete")
    .map((args) => args[args.length - 1]);
}

describe("finalizeRestoreStaging", () => {
  it("forgets what was read about the home it replaces", async () => {
    await finalizeRestoreStaging({ home, stagingPath } as any);
    expect(moves[1]).toEqual([stagingPath, home]);
    // (the cached subvolume ids and quota scan: another subvolume is at the
    // home's path now, qgroup-scan.ts)
    expect(forgotten).toEqual([[home, moves[0][1], stagingPath]]);
  });

  it("a recover over a home with data KEEPS the old home and its snapshots, and warns (068-DS)", async () => {
    homeEntries.set(home, [".snapshots", "work.ipynb"]);
    homeEntries.set(stagingPath, ["from-backup.txt"]);
    const result = await finalizeRestoreStaging({
      project_id: "p-1",
      home,
      stagingPath,
      restore: "recover",
    } as any);
    const oldPath = moves[0][1];
    expect(oldPath).toMatch(/\.restore_old\./);
    // the restored copy is the home now; the previous one is beside it
    expect(moves[1]).toEqual([stagingPath, home]);
    expect(existing.has(oldPath)).toBe(true);
    // nothing deleted: neither the old home nor any snapshot under it
    expect(deletedPaths()).toEqual([]);
    expect(btrfsCalls).toEqual([]);
    expect(warnings).toEqual([
      [
        "recover kept the previous home aside",
        { project_id: "p-1", path: oldPath },
      ],
    ]);
    // the caller keeps the old home's edit history too
    expect(result).toEqual({ keptOldHome: oldPath });
  });

  it("decides from the OLD home before the swap: a populated home over an EMPTY backup is kept", async () => {
    homeEntries.set(home, ["work.ipynb"]);
    homeEntries.set(stagingPath, []);
    const result = await finalizeRestoreStaging({
      project_id: "p-1",
      home,
      stagingPath,
      restore: "recover",
    } as any);
    expect(deletedPaths()).toEqual([]);
    expect(result).toEqual({ keptOldHome: moves[0][1] });
  });

  it("a home whose only content is non-empty snapshots is kept (backups exclude .snapshots)", async () => {
    homeEntries.set(home, [".snapshots"]);
    homeEntries.set(`${home}/.snapshots`, ["2026-11-01"]);
    await finalizeRestoreStaging({
      project_id: "p-1",
      home,
      stagingPath,
      restore: "recover",
    } as any);
    expect(deletedPaths()).toEqual([]);
  });

  it("a recover over a home with only an EMPTY snapshot directory deletes it as before", async () => {
    homeEntries.set(home, [".snapshots"]);
    homeEntries.set(`${home}/.snapshots`, []);
    await finalizeRestoreStaging({
      project_id: "p-1",
      home,
      stagingPath,
      restore: "recover",
    } as any);
    expect(deletedPaths()).toEqual([moves[0][1]]);
    expect(warnings).toEqual([]);
  });

  it("an explicit restore over a populated home keeps today's semantics (it deletes the old home)", async () => {
    homeEntries.set(home, ["work.ipynb"]);
    await finalizeRestoreStaging({
      project_id: "p-1",
      home,
      stagingPath,
      restore: "required",
    } as any);
    expect(deletedPaths()).toEqual([moves[0][1]]);
    expect(warnings).toEqual([]);
  });
});
