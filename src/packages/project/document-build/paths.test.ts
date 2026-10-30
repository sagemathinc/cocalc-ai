/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { documentProcessPath, normalizeDocumentPath } from "./paths";

const env = {
  COCALC_RUNTIME_HOME: "/home/user",
  HOME: "/projects/example",
};

describe("document build paths", () => {
  it("normalizes relative and legacy runtime paths", () => {
    expect(normalizeDocumentPath("papers/a.tex", env)).toBe(
      "/home/user/papers/a.tex",
    );
    expect(normalizeDocumentPath("/root/papers/a.tex", env)).toBe(
      "/home/user/papers/a.tex",
    );
  });

  it("maps project-visible paths to the process home", () => {
    expect(documentProcessPath("/home/user/papers/a.tex", env)).toBe(
      "/projects/example/papers/a.tex",
    );
  });

  it("rejects paths outside the project home", () => {
    expect(() => normalizeDocumentPath("../../etc/passwd", env)).toThrow(
      "inside /home/user",
    );
    expect(() => normalizeDocumentPath("/etc/passwd", env)).toThrow(
      "inside /home/user",
    );
  });

  it("in a project container (HOME=/home/user), keeps the legacy /root alias", () => {
    const container = { HOME: "/home/user" };
    expect(normalizeDocumentPath("/root/papers/a.tex", container)).toBe(
      "/home/user/papers/a.tex",
    );
    expect(documentProcessPath("/home/user/papers/a.tex", container)).toBe(
      "/home/user/papers/a.tex",
    );
  });

  describe("cocalc-plus and lite: the home is the user's own HOME", () => {
    const laptop = { HOME: "/Users/alice" };

    it("builds files under that HOME, by absolute or relative path", () => {
      expect(normalizeDocumentPath("/Users/alice/papers/a.tex", laptop)).toBe(
        "/Users/alice/papers/a.tex",
      );
      expect(normalizeDocumentPath("papers/a.tex", laptop)).toBe(
        "/Users/alice/papers/a.tex",
      );
      expect(documentProcessPath("/Users/alice/papers/a.tex", laptop)).toBe(
        "/Users/alice/papers/a.tex",
      );
    });

    it("never treats /home/user or /root as this home", () => {
      expect(() =>
        normalizeDocumentPath("/home/user/papers/a.tex", laptop),
      ).toThrow("inside /Users/alice");
      expect(() => normalizeDocumentPath("/root/a.tex", laptop)).toThrow(
        "inside /Users/alice",
      );
      expect(() => normalizeDocumentPath("../bob/a.tex", laptop)).toThrow(
        "inside /Users/alice",
      );
    });

    it("works with HOME at the filesystem root", () => {
      const root = { HOME: "/" };
      expect(normalizeDocumentPath("/paper.tex", root)).toBe("/paper.tex");
      expect(normalizeDocumentPath("/papers/a.tex", root)).toBe(
        "/papers/a.tex",
      );
      expect(documentProcessPath("/papers/a.tex", root)).toBe("/papers/a.tex");
      expect(() => normalizeDocumentPath("/", root)).toThrow(
        "must identify a file",
      );
    });

    it("accepts the real path of a HOME that is a symlink", () => {
      const base = realpathSync(mkdtempSync(path.join(tmpdir(), "docbuild-")));
      try {
        const real = path.join(base, "data", "alice");
        mkdirSync(real, { recursive: true });
        const link = path.join(base, "alice");
        symlinkSync(real, link);
        const symlinked = { HOME: link };
        // get_homeDirectory reports the real path, so clients may send it.
        expect(
          documentProcessPath(path.join(real, "papers", "a.tex"), symlinked),
        ).toBe(path.join(link, "papers", "a.tex"));
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
});
