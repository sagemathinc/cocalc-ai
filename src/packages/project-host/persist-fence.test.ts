/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const withPersistFence = jest.fn();

jest.mock("@cocalc/conat/persist/fence", () => {
  class PersistFenceUnavailableError extends Error {}
  return {
    PersistFenceUnavailableError,
    withPersistFence: (...args: any[]) => withPersistFence(...args),
  };
});

import { PersistFenceUnavailableError } from "@cocalc/conat/persist/fence";
import {
  persistDirInHome,
  restoreTouchesPersistFiles,
  setPersistFenceClient,
  withProjectPersistFenced,
} from "./persist-fence";

const project_id = "11111111-1111-4111-8111-111111111111";
const home = `/mnt/cocalc/project-${project_id}`;
const inHome = "/mnt/cocalc/project-[project_id]/.local/share/cocalc/persist";
const outside = "/mnt/cocalc/project-[project_id]-persist";

describe("persistDirInHome", () => {
  it("is the persist directory relative to the home", () => {
    expect(persistDirInHome(project_id, home, inHome)).toBe(
      ".local/share/cocalc/persist",
    );
  });

  it("is undefined when the persist files are not in the home", () => {
    expect(persistDirInHome(project_id, home, outside)).toBeUndefined();
    expect(persistDirInHome(project_id, home, "")).toBeUndefined();
    expect(
      persistDirInHome(project_id, home, "/var/lib/persist"),
    ).toBeUndefined();
  });
});

describe("restoreTouchesPersistFiles", () => {
  const touches = (dest: string, template = inHome) =>
    restoreTouchesPersistFiles({ project_id, home, dest, template });

  it("a restore of the whole home, or of a directory containing the persist directory, touches them", () => {
    expect(touches("")).toBe(true);
    expect(touches(".")).toBe(true);
    expect(touches(".local")).toBe(true);
    expect(touches(".local/share/cocalc")).toBe(true);
    expect(touches(".local/share/cocalc/persist")).toBe(true);
    expect(touches(".local/share/cocalc/persist/projects")).toBe(true);
  });

  it("a restore elsewhere in the home does not", () => {
    expect(touches("work")).toBe(false);
    expect(touches(".local/share/jupyter")).toBe(false);
    expect(touches(".local/share/cocalc/persisted")).toBe(false);
  });

  it("nothing touches them when they are not in the home", () => {
    expect(touches("", outside)).toBe(false);
  });
});

describe("withProjectPersistFenced", () => {
  afterEach(() => {
    withPersistFence.mockReset();
    setPersistFenceClient(undefined);
  });

  it("runs fn under the fence", async () => {
    const client: any = {};
    setPersistFenceClient(client);
    withPersistFence.mockImplementation(async (_opts, fn) => await fn());
    await expect(
      withProjectPersistFenced(
        { project_id, reason: "test" },
        async () => "done",
      ),
    ).resolves.toBe("done");
    expect(withPersistFence).toHaveBeenCalledWith(
      { client, project_id },
      expect.any(Function),
    );
  });

  it("goes ahead unfenced when no fence service runs", async () => {
    setPersistFenceClient({} as any);
    withPersistFence.mockRejectedValue(
      new PersistFenceUnavailableError("no subscribers"),
    );
    const fn = jest.fn(async () => "done");
    await expect(
      withProjectPersistFenced({ project_id, reason: "test" }, fn),
    ).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fails, without running fn, when the fence cannot be taken", async () => {
    setPersistFenceClient({} as any);
    withPersistFence.mockRejectedValue(new Error("already fenced"));
    const fn = jest.fn(async () => "done");
    await expect(
      withProjectPersistFenced({ project_id, reason: "test" }, fn),
    ).rejects.toThrow("already fenced");
    expect(fn).not.toHaveBeenCalled();
  });
});
