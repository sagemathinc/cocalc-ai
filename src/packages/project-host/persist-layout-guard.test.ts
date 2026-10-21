/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBundleKeepsPersistVolumes,
  hostHasPersistVolumes,
  PersistLayoutDowngradeError,
} from "./persist-layout-guard";

const PROJECT = "11111111-2222-4333-8444-555555555555";

describe("never back past persist volumes", () => {
  let base: string;
  let mount: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "persist-layout-guard-"));
    mount = join(base, "mnt");
    mkdirSync(join(mount, `project-${PROJECT}`), { recursive: true });
    env = {
      COCALC_SYNC_PROJECTS: `${mount}/project-[project_id]/.local/share/cocalc/persist`,
    };
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

  const volume = (ready: boolean) => {
    const root = join(mount, `project-${PROJECT}-persist`);
    mkdirSync(root, { recursive: true });
    if (ready) writeFileSync(join(root, ".cocalc-persist-ready"), "{}");
  };

  it("lets a host where no history moved yet run any version", () => {
    expect(hostHasPersistVolumes(env)).toBe(false);
    // an import that never finished moved nothing
    volume(false);
    expect(hostHasPersistVolumes(env)).toBe(false);
    expect(() =>
      assertBundleKeepsPersistVolumes(bundle(false), env),
    ).not.toThrow();
  });

  it("refuses a version from before persist volumes once a history moved", () => {
    volume(true);
    expect(hostHasPersistVolumes(env)).toBe(true);
    expect(() => assertBundleKeepsPersistVolumes(bundle(false), env)).toThrow(
      PersistLayoutDowngradeError,
    );
    expect(() =>
      assertBundleKeepsPersistVolumes(bundle(true), env),
    ).not.toThrow();
  });

  it("allows it by hand", () => {
    volume(true);
    expect(() =>
      assertBundleKeepsPersistVolumes(bundle(false), {
        ...env,
        COCALC_ALLOW_PERSIST_LAYOUT_DOWNGRADE: "1",
      }),
    ).not.toThrow();
  });

  it("is off where the history stays in the homes", () => {
    volume(true);
    const off = { ...env, COCALC_PERSIST_PROJECT_VOLUME: "0" };
    expect(hostHasPersistVolumes(off)).toBe(false);
    expect(() =>
      assertBundleKeepsPersistVolumes(bundle(false), off),
    ).not.toThrow();
  });
});
