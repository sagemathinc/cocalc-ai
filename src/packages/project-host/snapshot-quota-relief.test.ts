/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let state: string | undefined;
const mockWithSubvolumeQuotaRelief = jest.fn(
  async ({ run }: { run: () => Promise<unknown> }) => await run(),
);

jest.mock("./sqlite/projects", () => ({
  getProject: () => (state == null ? undefined : { state }),
}));

jest.mock("@cocalc/file-server/btrfs/subvolume-snapshots", () => ({
  ...jest.requireActual("@cocalc/file-server/btrfs/subvolume-snapshots"),
  withSubvolumeQuotaRelief: (opts: any) => mockWithSubvolumeQuotaRelief(opts),
}));

import { QuotaReliefUnavailableError } from "@cocalc/file-server/btrfs/subvolume-snapshots";
import {
  acquireProjectWriteLease,
  resetProjectWriteFenceForTesting,
  withProjectWriteLease,
} from "./project-write-fence";
import { stoppedProjectSnapshotQuotaRelief } from "./snapshot-quota-relief";

const P = "00000000-1000-4000-8000-000000000001";
const volume = { name: "project-1" } as any;

describe("scheduled snapshot quota relief", () => {
  beforeEach(() => {
    mockWithSubvolumeQuotaRelief.mockClear();
    state = "opened";
  });
  afterEach(() => resetProjectWriteFenceForTesting());

  it("raises the quota a little for a stopped project", async () => {
    const relief = stoppedProjectSnapshotQuotaRelief(P, volume);
    await expect(relief(async () => "snapshot")).resolves.toBe("snapshot");
    expect(mockWithSubvolumeQuotaRelief).toHaveBeenCalledWith(
      expect.objectContaining({
        subvolume: volume,
        reliefBytes: 64 * 1024 * 1024,
      }),
    );
  });

  it.each(["running", "starting", "stopping", undefined])(
    "gives no relief to a project that is %s",
    async (value) => {
      state = value;
      const run = jest.fn(async () => "snapshot");
      await expect(
        stoppedProjectSnapshotQuotaRelief(P, volume)(run),
      ).rejects.toBeInstanceOf(QuotaReliefUnavailableError);
      expect(run).not.toHaveBeenCalled();
      expect(mockWithSubvolumeQuotaRelief).not.toHaveBeenCalled();
    },
  );

  it("gives no relief while something writes into the project", async () => {
    const release = await acquireProjectWriteLease(P);
    await expect(
      stoppedProjectSnapshotQuotaRelief(P, volume)(async () => "snapshot"),
    ).rejects.toBeInstanceOf(QuotaReliefUnavailableError);
    expect(mockWithSubvolumeQuotaRelief).not.toHaveBeenCalled();
    release();
  });

  it("holds writers off while the quota is raised", async () => {
    const events: string[] = [];
    let open!: () => void;
    mockWithSubvolumeQuotaRelief.mockImplementationOnce(async ({ run }) => {
      events.push("raised");
      await new Promise<void>((resolve) => (open = resolve));
      const result = await run();
      events.push("restored");
      return result;
    });
    const relief = stoppedProjectSnapshotQuotaRelief(
      P,
      volume,
    )(async () => "snapshot");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const write = withProjectWriteLease(P, async () => {
      events.push("write");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["raised"]);
    open();
    await Promise.all([relief, write]);
    expect(events).toEqual(["raised", "restored", "write"]);
  });
});
