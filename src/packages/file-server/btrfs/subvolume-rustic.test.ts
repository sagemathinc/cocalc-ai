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
  it("excludes .snapshots from future backups", async () => {
    const rusticCalls: any[] = [];
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
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
      snapshots: {
        path: (name: string) => `.snapshots/${name}`,
        create: jest.fn(async () => {}),
        delete: jest.fn(async () => {}),
      },
    } as any);

    await rustic.backup();

    expect(rusticCalls).toHaveLength(1);
    expect(rusticCalls[0].args).toEqual([
      "backup",
      "-x",
      "--json",
      "--glob",
      ".snapshots",
      "--glob",
      ".snapshots/**",
      ".",
    ]);
    expect(rusticCalls[0].opts.cwd).toMatch(
      /^\.snapshots\/temp-rustic-snapshot-/,
    );
  });
});
