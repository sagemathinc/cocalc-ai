/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBundleKeepsPersistVolumes,
  assertPersistVolumesStayOn,
  commitToPersistVolumes,
  hostCommittedToPersistVolumes,
  PersistLayoutDowngradeError,
} from "./persist-layout-guard";

describe("never back past persist volumes", () => {
  let base: string;
  let dataDir: string;
  let current: string;
  let env: Record<string, string>;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "persist-layout-guard-"));
    dataDir = join(base, "data");
    current = join(base, "current");
    env = { COCALC_PROJECT_HOST_CURRENT: current };
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // a project-host bundle, from before persist volumes or not
  const bundle = (persistVolumes: boolean) => {
    const root = join(base, persistVolumes ? "new" : "old");
    mkdirSync(join(root, "dist"), { recursive: true });
    if (persistVolumes) {
      writeFileSync(join(root, "dist", "persist-volume.js"), "");
    }
    return root;
  };

  const where = () => ({ dataDir, env });

  it("lets a host that never kept histories in volumes run any version", () => {
    expect(hostCommittedToPersistVolumes(dataDir)).toBe(false);
    expect(() =>
      assertBundleKeepsPersistVolumes(bundle(false), where()),
    ).not.toThrow();
    expect(() => assertPersistVolumesStayOn(where())).not.toThrow();
  });

  it("once a persist server committed to volumes, refuses older versions and turning volumes off", () => {
    symlinkSync(bundle(true), current);
    commitToPersistVolumes(where());
    expect(hostCommittedToPersistVolumes(dataDir)).toBe(true);
    expect(() =>
      assertBundleKeepsPersistVolumes(bundle(false), where()),
    ).toThrow(PersistLayoutDowngradeError);
    expect(() =>
      assertBundleKeepsPersistVolumes(bundle(true), where()),
    ).not.toThrow();
    // e.g., COCALC_PERSIST_PROJECT_VOLUME=0
    expect(() => assertPersistVolumesStayOn(where())).toThrow(
      PersistLayoutDowngradeError,
    );
  });

  it("a persist server doesn't move histories when an older version was activated meanwhile", () => {
    // an activation that raced it: the record is kept, the server refuses
    symlinkSync(bundle(false), current);
    expect(() => commitToPersistVolumes(where())).toThrow(
      PersistLayoutDowngradeError,
    );
    expect(hostCommittedToPersistVolumes(dataDir)).toBe(true);
  });

  it("commits without a current bundle (e.g., in development)", () => {
    commitToPersistVolumes(where());
    expect(existsSync(join(dataDir, "persist-volume-layout"))).toBe(true);
  });

  it("fails closed when the record can't be checked", () => {
    // a directory it can't look into: anything but missing counts
    symlinkSync("loop", join(base, "loop"));
    expect(() => hostCommittedToPersistVolumes(join(base, "loop"))).toThrow(
      /ELOOP/,
    );
  });

  it("does no work when imported, so the daemon CLI passes its own environment on", () => {
    // @cocalc/backend/data sets process.env.DATA when imported, and the
    // daemon CLI (which imports this) starts the host agent with its env
    const saved = { ...process.env };
    delete process.env.DATA;
    delete process.env.COCALC_DATA_DIR;
    try {
      jest.isolateModules(() => {
        require("./persist-layout-guard");
        require("./daemon");
      });
      expect(process.env.DATA).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  it("allows it by hand", () => {
    symlinkSync(bundle(true), current);
    commitToPersistVolumes(where());
    const byHand = {
      dataDir,
      env: { ...env, COCALC_ALLOW_PERSIST_LAYOUT_DOWNGRADE: "1" },
    };
    expect(() =>
      assertBundleKeepsPersistVolumes(bundle(false), byHand),
    ).not.toThrow();
    expect(() => assertPersistVolumesStayOn(byHand)).not.toThrow();
  });
});
