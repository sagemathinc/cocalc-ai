import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupReportHeaderSha256,
  verifyBackupExclusionReport,
} from "./backup-exclusion-report";

// Opt-in: never pick a system Rustic that lacks the pinned report capability.
const binary = process.env.COCALC_TEST_NATIVE_RUSTIC;
(binary ? describe : describe.skip)("native exclusion protocol", () => {
  it("consumes the actual CLI report and compares its selection with restored files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocalc-exclusion-protocol-"));
    const source = join(root, "source");
    try {
      await mkdir(source);
      const file = await open(join(source, "huge"), "w");
      try {
        await file.truncate(2 ** 40);
      } finally {
        await file.close();
      }
      const weird = Buffer.concat([
        Buffer.from(source + "/"),
        Buffer.from([255, 10, 42, 63]),
      ]);
      await link(join(source, "huge"), weird);
      await writeFile(join(source, "equal"), "1234");
      const run = (...args: string[]) => {
        const result = spawnSync(
          binary!,
          [
            "--no-progress",
            "--password",
            "test",
            "--repository",
            join(root, "repo"),
            ...args,
          ],
          {
            cwd: source,
            timeout: 15000,
            maxBuffer: 1024 * 1024,
          },
        );
        if (result.error) throw result.error;
        if (result.status !== 0)
          throw new Error(`candidate command failed: ${result.stderr}`);
        return result.stdout;
      };
      run("init");
      const raw = run(
        "backup-inventory",
        "--exclusion-report",
        "--exclude-larger-than",
        "4",
        "--max-report-bytes",
        "32768",
        "--max-entries",
        "20",
        "--max-metadata-bytes",
        "32768",
        "--max-file-bytes",
        "4",
        "--max-apparent-bytes",
        "4",
        "--max-chunk-references",
        "1",
        ".",
      );
      // This fixture's trusted producer is the explicitly supplied local binary;
      // production obtains expected hashes from protected backup metadata instead.
      const header = JSON.parse(raw.subarray(0, raw.indexOf(10)).toString());
      async function* stream() {
        for (let i = 0; i < raw.length; i += 7) yield raw.subarray(i, i + 7);
      }
      const report = await verifyBackupExclusionReport({
        chunks: stream(),
        sha256: createHash("sha256").update(raw).digest("hex"),
        header_sha256: backupReportHeaderSha256(header),
        policy_sha256: "a".repeat(64),
        max_bytes: 32768,
        max_record_bytes: 8192,
        max_entries: 20,
        max_path_depth: 10,
      });
      expect(report.excluded_files).toBe("2");
      expect(report.excluded_apparent_bytes).toBe((2n ** 41n).toString());
      expect(report.sample.map((item) => item.path_hex).sort()).toEqual([
        "68756765",
        "ff0a2a3f",
      ]);
      expect(
        report.sample.every((item) => item.acknowledgement_key != null),
      ).toBe(true);
      const backup = JSON.parse(
        run(
          "backup",
          "--strict",
          "--json",
          "--exclude-larger-than",
          "4",
          ".",
        ).toString(),
      );
      run(
        "restore",
        "--strict",
        "--sparse",
        "by-content-required",
        backup.id,
        join(root, "restored"),
      );
      expect(await readFile(join(root, "restored", "equal"), "utf8")).toBe(
        "1234",
      );
      await expect(stat(join(root, "restored", "huge"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await stat(join(source, "huge"))).size).toBe(2 ** 40);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
