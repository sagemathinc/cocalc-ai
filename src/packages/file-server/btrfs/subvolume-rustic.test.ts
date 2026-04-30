import { parseRusticSnapshotsOutput } from "./subvolume-rustic";

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
