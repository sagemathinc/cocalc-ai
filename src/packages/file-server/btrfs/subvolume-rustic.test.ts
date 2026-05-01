let btrfsMock: jest.Mock;
let sudoMock: jest.Mock;

jest.mock("./util", () => ({
  btrfs: (...args: any[]) => btrfsMock(...args),
  sudo: (...args: any[]) => sudoMock(...args),
}));

import {
  parseRusticSnapshotsOutput,
  SubvolumeRustic,
} from "./subvolume-rustic";

describe("parseRusticSnapshotsOutput", () => {
  it("parses grouped rustic snapshot JSON", () => {
    expect(
      parseRusticSnapshotsOutput({
        stdout: JSON.stringify([
          {
            group_key: { hostname: "project-1" },
            snapshots: [
              {
                id: "snap-old",
                time: "2026-04-30T20:00:00.000Z",
                summary: { files_new: 1 },
              },
              {
                id: "snap-new",
                time: "2026-04-30T21:00:00.000Z",
                summary: { files_new: 2 },
              },
            ],
          },
        ]),
        host: "project-1",
      }),
    ).toEqual([
      {
        id: "snap-old",
        time: new Date("2026-04-30T20:00:00.000Z"),
        summary: { files_new: 1 },
      },
      {
        id: "snap-new",
        time: new Date("2026-04-30T21:00:00.000Z"),
        summary: { files_new: 2 },
      },
    ]);
  });

  it("throws a descriptive error for truncated output", () => {
    expect(() =>
      parseRusticSnapshotsOutput({
        stdout: '[{"group_key":',
        truncated: true,
        host: "project-1",
      }),
    ).toThrow(
      "rustic snapshots output truncated while listing backups for project-1",
    );
  });
});

describe("SubvolumeRustic.backup", () => {
  beforeEach(() => {
    btrfsMock = jest.fn(async () => undefined);
    sudoMock = jest.fn(async () => undefined);
  });

  it("excludes .snapshots from future backups", async () => {
    const rusticCalls: any[] = [];
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: {
        opts: { mount: "/mnt/test" },
      },
      fs: {
        rustic: jest.fn(async (args, opts) => {
          rusticCalls.push({ args, opts });
          return {
            stdout: Buffer.from(
              JSON.stringify({
                time: "2026-04-30T21:00:00.000Z",
                id: "snap-1",
                summary: { files_new: 1 },
              }),
            ),
            stderr: Buffer.alloc(0),
            code: 0,
            truncated: false,
          };
        }),
      },
    } as any);

    await rustic.backup();

    expect(sudoMock).toHaveBeenCalledWith({
      command: "mkdir",
      args: ["-p", "/mnt/test/.rustic-backup-staging/project-1"],
    });
    expect(btrfsMock).toHaveBeenNthCalledWith(1, {
      args: [
        "subvolume",
        "snapshot",
        "-r",
        "/mnt/test/project-1",
        expect.stringMatching(
          /^\/mnt\/test\/\.rustic-backup-staging\/project-1\/temp-rustic-snapshot-/,
        ),
      ],
    });
    expect(rusticCalls).toHaveLength(1);
    expect(rusticCalls[0].args).toEqual([
      "backup",
      "-x",
      "--json",
      "--glob",
      "!.snapshots",
      "--glob",
      "!.snapshots/**",
      ".",
    ]);
    expect(rusticCalls[0].opts.cwd).toMatch(
      /^\/mnt\/test\/\.rustic-backup-staging\/project-1\/temp-rustic-snapshot-/,
    );
    expect(btrfsMock).toHaveBeenNthCalledWith(2, {
      args: [
        "subvolume",
        "delete",
        expect.stringMatching(
          /^\/mnt\/test\/\.rustic-backup-staging\/project-1\/temp-rustic-snapshot-/,
        ),
      ],
      err_on_exit: false,
      verbose: false,
    });
  });
});
