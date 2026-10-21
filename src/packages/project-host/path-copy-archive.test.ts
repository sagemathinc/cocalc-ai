/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  archivePathIsAllowed,
  decodePathCopyArchiveListing,
  installPathFromStaging,
  replacePathFromStaging,
} from "./path-copy-archive";

describe("path copy archive listings", () => {
  it("decodes GNU tar C-quoted UTF-8 paths before validation", () => {
    const entries = decodePathCopyArchiveListing(
      Buffer.from(
        '"Introduction \\303\\240 l\'informatique.ipynb"\n' +
          '"Introduction \\303\\240 l\'informatique.ipynb/data.json"\n',
      ),
    );

    expect(entries).toEqual([
      "Introduction à l'informatique.ipynb",
      "Introduction à l'informatique.ipynb/data.json",
    ]);
    const allowedRoots = new Set(["Introduction à l'informatique.ipynb"]);
    expect(
      entries.every((entry) => archivePathIsAllowed({ entry, allowedRoots })),
    ).toBe(true);
  });

  it("continues to reject paths outside the selected roots", () => {
    const allowedRoots = new Set(["assignment"]);
    for (const entry of [
      "../outside",
      "/absolute",
      "assignment/../../outside",
      "assignment\\..\\outside",
      "other/file",
    ]) {
      expect(archivePathIsAllowed({ entry, allowedRoots })).toBe(false);
    }
  });

  it("rejects unexpected text after a quoted archive path", () => {
    expect(() =>
      decodePathCopyArchiveListing(Buffer.from('"assignment/file" trailing\n')),
    ).toThrow("unexpected output");
  });

  it("replaces an existing directory at the exact destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cocalc-copy-replace-"));
    try {
      await mkdir(path.join(root, "source-assignment"));
      await mkdir(path.join(root, "collected-assignment"));
      await writeFile(path.join(root, "source-assignment", "new.txt"), "new");
      await writeFile(
        path.join(root, "collected-assignment", "old.txt"),
        "old",
      );
      const destination = path.join(root, "collected-assignment");

      await replacePathFromStaging({
        source: { root, path: "source-assignment" },
        destination: { root, path: "collected-assignment" },
      });

      expect(await readFile(path.join(destination, "new.txt"), "utf8")).toBe(
        "new",
      );
      await expect(
        readFile(path.join(destination, "old.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(
          path.join(destination, "source-assignment", "new.txt"),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(root)).sort()).toEqual([
        "collected-assignment",
        "source-assignment",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges an ordinary directory copy at the resolved destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cocalc-copy-merge-"));
    try {
      const destination = path.join(root, "handouts", "lecture notes");
      await mkdir(path.join(root, "source"));
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(root, "source", "new.txt"), "new");
      await writeFile(path.join(destination, "keep.txt"), "keep");

      await installPathFromStaging({
        source: { root, path: "source" },
        destination: { root, path: "handouts/lecture notes" },
        options: { force: false },
      });

      expect(await readFile(path.join(destination, "new.txt"), "utf8")).toBe(
        "new",
      );
      expect(await readFile(path.join(destination, "keep.txt"), "utf8")).toBe(
        "keep",
      );
      await expect(
        readFile(path.join(destination, "source", "new.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips an exact no-clobber copy when the destination exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cocalc-copy-skip-"));
    try {
      await writeFile(path.join(root, "source"), "new");
      await writeFile(path.join(root, "destination"), "keep");
      await expect(
        installPathFromStaging({
          source: { root, path: "source" },
          destination: { root, path: "destination" },
          exact: true,
          options: { force: false },
        }),
      ).resolves.toBe(false);
      expect(await readFile(path.join(root, "destination"), "utf8")).toBe(
        "keep",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves the destination untouched when staging the copy fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cocalc-copy-replace-"));
    try {
      await mkdir(path.join(root, "destination"));
      await writeFile(path.join(root, "destination", "keep.txt"), "keep");

      await expect(
        replacePathFromStaging({
          source: { root, path: "missing-source" },
          destination: { root, path: "destination" },
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await readFile(path.join(root, "destination", "keep.txt"), "utf8"),
      ).toBe("keep");
      expect(await readdir(root)).toEqual(["destination"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never writes through a symlink the destination project planted", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "cocalc-copy-escape-"));
    try {
      const staging = path.join(base, "staging");
      const home = path.join(base, "home");
      const outside = path.join(base, "outside");
      await mkdir(staging);
      await mkdir(home);
      await mkdir(outside);
      await writeFile(path.join(staging, "payload"), "attacker data");
      await symlink(outside, path.join(home, "evil"));

      for (const exact of [false, true]) {
        await expect(
          installPathFromStaging({
            source: { root: staging, path: "payload" },
            destination: { root: home, path: "evil/authorized_keys" },
            exact,
          }),
        ).rejects.toThrow(/ELOOP/);
      }
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("replaces a destination that is itself a symlink, not its target", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "cocalc-copy-escape-"));
    try {
      const staging = path.join(base, "staging");
      const home = path.join(base, "home");
      const outside = path.join(base, "outside");
      await mkdir(staging);
      await mkdir(home);
      await mkdir(outside);
      await mkdir(path.join(staging, "assignment"));
      await writeFile(path.join(staging, "assignment", "a.txt"), "a");
      await symlink(outside, path.join(home, "assignment"));

      await installPathFromStaging({
        source: { root: staging, path: "assignment" },
        destination: { root: home, path: "assignment" },
        exact: true,
      });

      expect(
        await readFile(path.join(home, "assignment", "a.txt"), "utf8"),
      ).toBe("a");
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps an exact no-clobber destination that appears during the copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cocalc-copy-race-"));
    try {
      await mkdir(path.join(root, "source"));
      await writeFile(path.join(root, "source", "a.txt"), "from source");
      const appear = () =>
        require("node:fs").mkdirSync(path.join(root, "destination"), {
          recursive: true,
        });

      await expect(
        installPathFromStaging({
          source: { root, path: "source" },
          destination: { root, path: "destination" },
          exact: true,
          options: { force: false, checkpoint: appear },
        }),
      ).resolves.toBe(false);
      expect(await readdir(path.join(root, "destination"))).toEqual([]);

      await rm(path.join(root, "destination"), { recursive: true });
      await expect(
        installPathFromStaging({
          source: { root, path: "source" },
          destination: { root, path: "destination" },
          exact: true,
          options: { force: false, errorOnExist: true, checkpoint: appear },
        }),
      ).rejects.toMatchObject({ code: "ERR_FS_CP_EEXIST" });
      expect((await readdir(root)).sort()).toEqual(["destination", "source"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an exact copy onto itself, even through a hard link", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cocalc-copy-self-"));
    try {
      await writeFile(path.join(root, "same"), "data");
      await link(path.join(root, "same"), path.join(root, "alias"));
      await expect(
        installPathFromStaging({
          source: { root, path: "same" },
          destination: { root, path: "same" },
          exact: true,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        installPathFromStaging({
          source: { root, path: "same" },
          destination: { root, path: "alias" },
          exact: true,
        }),
      ).rejects.toMatchObject({ code: "ERR_FS_CP_EINVAL" });
      expect((await readdir(root)).sort()).toEqual(["alias", "same"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces an exact destination whose name has the maximum length", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cocalc-copy-long-"));
    try {
      const long = "n".repeat(255);
      await mkdir(path.join(root, "source"));
      await writeFile(path.join(root, "source", "a.txt"), "new");
      await mkdir(path.join(root, long));
      await expect(
        installPathFromStaging({
          source: { root, path: "source" },
          destination: { root, path: long },
          exact: true,
        }),
      ).resolves.toBe(true);
      expect(await readFile(path.join(root, long, "a.txt"), "utf8")).toBe(
        "new",
      );
      expect((await readdir(root)).sort()).toEqual([long, "source"].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces an exact destination that appears just as the copy is placed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cocalc-copy-handoff-"));
    const { SandboxRoot } = require("@cocalc/openat2");
    const real = SandboxRoot.prototype.renameNoReplace;
    let raced = false;
    const spy = jest
      .spyOn(SandboxRoot.prototype, "renameNoReplace")
      .mockImplementation(function (this: any, from: string, to: string) {
        if (!raced && to === "destination") {
          // An editor creates the destination right before the handoff.
          raced = true;
          require("node:fs").writeFileSync(
            path.join(root, "destination"),
            "theirs",
          );
        }
        return real.call(this, from, to);
      });
    try {
      await writeFile(path.join(root, "source"), "from source");
      await expect(
        installPathFromStaging({
          source: { root, path: "source" },
          destination: { root, path: "destination" },
          exact: true,
        }),
      ).resolves.toBe(true);
      expect(raced).toBe(true);
      expect(await readFile(path.join(root, "destination"), "utf8")).toBe(
        "from source",
      );
      expect((await readdir(root)).sort()).toEqual(["destination", "source"]);
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
