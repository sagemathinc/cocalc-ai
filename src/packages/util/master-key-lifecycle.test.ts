import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createSiteMasterKeyBackup,
  deriveSiteMasterKey,
  getOrCreateSiteMasterKey,
  getSiteMasterKeyStatus,
  readSiteMasterKeyBackupFile,
  restoreSiteMasterKeyBackup,
} from "./master-key-lifecycle";

describe("master-key-lifecycle", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cocalc-site-master-key-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates one site master key and derives distinct purpose keys", async () => {
    const secretsDir = join(dir, "secrets");
    const siteKey = await getOrCreateSiteMasterKey({ secretsDir });
    const siteKeyAgain = await getOrCreateSiteMasterKey({ secretsDir });

    expect(siteKey.length).toBe(32);
    expect(siteKeyAgain.equals(siteKey)).toBe(true);
    expect(
      deriveSiteMasterKey(siteKey, "secret-settings:v1").equals(
        deriveSiteMasterKey(siteKey, "project-backup-repo-secrets:v1"),
      ),
    ).toBe(false);
  });

  it("exports and restores an encrypted site master key backup", async () => {
    const sourceSecrets = join(dir, "source");
    const targetSecrets = join(dir, "target");
    const sourceKey = await getOrCreateSiteMasterKey({
      secretsDir: sourceSecrets,
    });
    const backupPath = join(dir, "site-master-key-backup.json");
    const backup = await createSiteMasterKeyBackup({
      paths: { secretsDir: sourceSecrets },
      passphrase: "correct horse battery staple",
    });
    await writeFile(backupPath, JSON.stringify(backup));

    const plain = await readSiteMasterKeyBackupFile({
      path: backupPath,
      passphrase: "correct horse battery staple",
    });
    await restoreSiteMasterKeyBackup({
      backup: plain,
      paths: { secretsDir: targetSecrets },
    });

    const restoredKey = Buffer.from(
      (await readFile(join(targetSecrets, "site-master-key"), "utf8")).trim(),
      "base64",
    );
    expect(restoredKey.equals(sourceKey)).toBe(true);
  });

  it("reports legacy key files without requiring them", async () => {
    const status = await getSiteMasterKeyStatus({
      secretsDir: join(dir, "secrets"),
    });
    expect(status.site_master_key.exists).toBe(false);
    expect(status.legacy_keys).toHaveLength(2);
    expect(status.needs_initialization).toBe(true);
    expect(status.backup_required).toBe(false);
  });
});
