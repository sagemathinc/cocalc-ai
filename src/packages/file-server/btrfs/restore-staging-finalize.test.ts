const existing = new Set<string>();
const moves: string[][] = [];
const forgotten: string[][] = [];

jest.mock("@cocalc/backend/misc/async-utils-node", () => ({
  exists: jest.fn(async (path: string) => existing.has(path)),
}));
jest.mock("@cocalc/file-server/btrfs/util", () => ({
  btrfs: jest.fn(async () => ({ stdout: "", stderr: "", exit_code: 0 })),
  sudo: jest.fn(
    async ({ command, args }: { command: string; args: string[] }) => {
      if (command === "mv") {
        moves.push(args);
        existing.delete(args[0]);
        existing.add(args[1]);
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

describe("finalizeRestoreStaging", () => {
  it("forgets what was read about the home it replaces", async () => {
    const home = "/mnt/cocalc/project-a";
    const stagingPath = "/mnt/cocalc/.restore-staging/project-a";
    existing.add(home);
    existing.add(stagingPath);
    await finalizeRestoreStaging({ home, stagingPath } as any);
    expect(moves[1]).toEqual([stagingPath, home]);
    // (the cached subvolume ids and quota scan: another subvolume is at the
    // home's path now, qgroup-scan.ts)
    expect(forgotten).toEqual([[home, moves[0][1], stagingPath]]);
  });
});
