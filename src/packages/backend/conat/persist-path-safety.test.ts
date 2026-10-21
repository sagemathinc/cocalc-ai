import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertSafePersistDatabasePath,
  projectRootForPersistPath,
} from "./persist-path-safety";

let base: string;
let template: string;
let project: string;
let persist: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "persist-path-safety-"));
  template = join(base, "project-[project_id]/.local/share/cocalc/persist");
  project = join(base, "project-abc");
  persist = join(project, ".local/share/cocalc/persist");
  mkdirSync(join(persist, "patchflow"), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const check = (path: string) => assertSafePersistDatabasePath(path, template);

describe("projectRootForPersistPath", () => {
  it("finds the project root of a path under the template", () => {
    expect(projectRootForPersistPath(join(persist, "a.db"), template)).toBe(
      project,
    );
  });

  it("supports a suffix after the project id", () => {
    const t = join(base, "project-[project_id]-persist");
    expect(
      projectRootForPersistPath(join(base, "project-abc-persist/a.db"), t),
    ).toBe(join(base, "project-abc-persist"));
    expect(
      projectRootForPersistPath(join(base, "project-abc/a.db"), t),
    ).toBeUndefined();
  });

  it("ignores paths outside the template", () => {
    expect(
      projectRootForPersistPath("/var/lib/x.db", template),
    ).toBeUndefined();
    expect(
      projectRootForPersistPath(join(persist, "a.db"), ""),
    ).toBeUndefined();
  });
});

describe("assertSafePersistDatabasePath", () => {
  it("accepts regular files and files not created yet", () => {
    const db = join(persist, "patchflow/a.db");
    check(db);
    writeFileSync(db, "");
    writeFileSync(db + "-wal", "");
    check(db);
    check(join(persist, "not/created/yet.db"));
  });

  it("refuses a symlinked database or WAL file", () => {
    const target = join(base, "elsewhere.db");
    writeFileSync(target, "");
    const db = join(persist, "patchflow/a.db");
    symlinkSync(target, db);
    expect(() => check(db)).toThrow(/is not a regular file/);
    const db2 = join(persist, "patchflow/b.db");
    writeFileSync(db2, "");
    symlinkSync(target, db2 + "-wal");
    expect(() => check(db2)).toThrow(/b\.db-wal is not a regular file/);
  });

  it("refuses a symlinked directory anywhere below the project root", () => {
    const elsewhere = join(base, "elsewhere");
    mkdirSync(join(elsewhere, "share/cocalc/persist"), { recursive: true });
    rmSync(join(project, ".local"), { recursive: true });
    symlinkSync(elsewhere, join(project, ".local"));
    expect(() => check(join(persist, "a.db"))).toThrow(
      /\.local is not a directory/,
    );
  });

  it("refuses a FIFO", () => {
    const db = join(persist, "fifo.db");
    execFileSync("mkfifo", [db]);
    expect(() => check(db)).toThrow(/is not a regular file/);
  });

  it("does not check paths outside projects", () => {
    const target = join(base, "elsewhere.db");
    writeFileSync(target, "");
    const link = join(base, "host-owned.db");
    symlinkSync(target, link);
    check(link);
  });
});
