/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
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
});
