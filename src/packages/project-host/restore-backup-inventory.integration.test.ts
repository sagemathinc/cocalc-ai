import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

jest.mock("@cocalc/backend/sandbox/install", () => ({
  rustic: process.env.COCALC_TEST_RUSTIC,
}));

import { listRestoreBackups } from "./restore-backup-inventory";

const binary = process.env.COCALC_TEST_RUSTIC;
const integration = binary ? describe : describe.skip;
integration(
  "native restore inventory with a synthetic multi-project repository",
  () => {
    let root: string;
    let profilePath: string;
    const projectId = "11111111-1111-4111-8111-111111111111";
    const host = `project-${projectId}`;
    function command(args: string[]) {
      return execFileSync(binary!, ["-P", profilePath.slice(0, -5), ...args], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "restore-inventory-test-"));
      profilePath = join(root, "profile.toml");
      writeFileSync(
        profilePath,
        `[repository]\nrepository = ${JSON.stringify(join(root, "repo"))}\npassword = "synthetic-test-only"\nno-cache = true\n`,
      );
      mkdirSync(join(root, "source"));
      writeFileSync(join(root, "source", "example.txt"), "synthetic data only");
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("lists fresh native snapshots without starting any browser and filters projects/indexes", async () => {
      command(["init"]);
      await expect(
        listRestoreBackups({ profilePath, projectId }),
      ).resolves.toEqual([]);
      for (const hostname of [host, "project-other", `${host}-index`, host]) {
        command(["backup", "--host", hostname, join(root, "source")]);
      }
      const backups = await listRestoreBackups({ profilePath, projectId });
      const native = JSON.parse(
        command(["snapshots", "--json", "--filter-host", host]),
      ).flatMap((group) => group.snapshots);
      expect(backups).toHaveLength(2);
      expect(backups.map((b) => b.id).sort()).toEqual(
        native.map((s) => s.id).sort(),
      );
      expect(backups.every((b) => Number.isFinite(b.time.getTime()))).toBe(
        true,
      );
      expect(backups.map((b) => b.summary)).toEqual([{}, {}]);
    }, 60_000);

    it("returns empty for a missing repository without creating it", async () => {
      await expect(
        listRestoreBackups({ profilePath, projectId }),
      ).resolves.toEqual([]);
      expect(existsSync(join(root, "repo", "config"))).toBe(false);
    });
  },
);
