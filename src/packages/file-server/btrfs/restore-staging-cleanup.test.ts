jest.mock("node:fs/promises", () => ({
  readdir: jest.fn(),
  rm: jest.fn(async () => undefined),
  stat: jest.fn(),
  writeFile: jest.fn(),
}));
jest.mock("@cocalc/backend/misc/async-utils-node", () => ({
  exists: jest.fn(async () => true),
}));
jest.mock("./util", () => ({ btrfs: jest.fn(), sudo: jest.fn() }));
jest.mock("./subvolume", () => ({
  isBtrfsSubvolume: jest.fn(async () => true),
}));

import { readdir, stat } from "node:fs/promises";
import { btrfs } from "./util";
import { cleanupRestoreStaging } from "./restore-staging";

it("a project cleanup never inspects or deletes another project's stale staging", async () => {
  const project_id = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  const root = "/mnt/cocalc";
  jest
    .mocked(readdir)
    .mockResolvedValue([
      `.restore_in_progress.${project_id}`,
      `.restore_in_progress.${other}`,
    ] as any);
  jest.mocked(stat).mockResolvedValue({ mtimeMs: 0 } as any);
  await cleanupRestoreStaging({ root, project_id });
  expect(stat).toHaveBeenCalledTimes(1);
  expect(stat).toHaveBeenCalledWith(
    `${root}/.restore-staging/.restore_in_progress.${project_id}`,
  );
  expect(btrfs).toHaveBeenCalledTimes(1);
  expect(btrfs).toHaveBeenCalledWith(
    expect.objectContaining({
      args: [
        "subvolume",
        "delete",
        `${root}/.restore-staging/project-${project_id}`,
      ],
    }),
  );
});
