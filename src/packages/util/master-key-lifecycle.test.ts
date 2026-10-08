import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  activateSiteMasterKey,
  createSiteMasterKeyBackup,
  decryptWithAnyKey,
  deriveSiteMasterKey,
  deriveSiteMasterKeyring,
  getOrCreateSiteMasterKey,
  getSiteMasterKeyring,
  parseSiteMasterKeyring,
  retireSiteMasterKey,
  siteMasterKeyId,
  stageNextSiteMasterKey,
  getSiteMasterKeyStatus,
  readSiteMasterKeyBackupFile,
  restoreSiteMasterKeyBackup,
  SITE_MASTER_KEY_CREDENTIAL_NAME,
  SITE_MASTER_KEY_REQUIRE_ENV,
  SYSTEMD_CREDENTIALS_DIRECTORY_ENV,
} from "./master-key-lifecycle";

describe("master-key-lifecycle", () => {
  let dir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    originalEnv = {
      [SITE_MASTER_KEY_REQUIRE_ENV]: process.env[SITE_MASTER_KEY_REQUIRE_ENV],
      [SYSTEMD_CREDENTIALS_DIRECTORY_ENV]:
        process.env[SYSTEMD_CREDENTIALS_DIRECTORY_ENV],
    };
    delete process.env[SITE_MASTER_KEY_REQUIRE_ENV];
    delete process.env[SYSTEMD_CREDENTIALS_DIRECTORY_ENV];
    dir = await mkdtemp(join(tmpdir(), "cocalc-site-master-key-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value == null) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
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

  it("fails closed when production requires a pre-provisioned key", async () => {
    process.env[SITE_MASTER_KEY_REQUIRE_ENV] = "1";
    await expect(
      getOrCreateSiteMasterKey({ secretsDir: join(dir, "secrets") }),
    ).rejects.toThrow("site master key is required but missing");
  });

  it("reads a systemd credential before the writable secrets directory", async () => {
    const credentialsDir = join(dir, "credentials");
    const secretsDir = join(dir, "secrets");
    const expected = Buffer.alloc(32, 7);
    await mkdir(credentialsDir);
    await writeFile(
      join(credentialsDir, SITE_MASTER_KEY_CREDENTIAL_NAME),
      expected.toString("base64"),
      { mode: 0o600 },
    );
    process.env[SYSTEMD_CREDENTIALS_DIRECTORY_ENV] = credentialsDir;

    const siteKey = await getOrCreateSiteMasterKey({ secretsDir });

    expect(siteKey.equals(expected)).toBe(true);
    const status = await getSiteMasterKeyStatus({ secretsDir });
    expect(status.site_master_key.source).toBe("systemd-credential");
    expect(status.site_master_key.read_only).toBe(true);
  });

  describe("keyring and rotation", () => {
    const keyPath = () => join(dir, "secrets", "site-master-key");
    const paths = () => ({ secretsDir: join(dir, "secrets") });
    const ids = async () =>
      (await getSiteMasterKeyring(paths())).map(
        ({ id, role }) => `${role}:${id}`,
      );

    it("has only the active key when there is no keyring file", async () => {
      const key = await getOrCreateSiteMasterKey(paths());
      expect(await ids()).toEqual([`active:${siteMasterKeyId(key)}`]);
      expect(siteMasterKeyId(key)).toMatch(/^smk_[A-Za-z0-9_-]{16}$/);
    });

    it("stages, activates, rolls back and retires keys without losing any", async () => {
      const k1 = await getOrCreateSiteMasterKey(paths());
      const id1 = siteMasterKeyId(k1);
      const { id: id2, key: k2 } = await stageNextSiteMasterKey(paths());
      expect(await ids()).toEqual([`active:${id1}`, `next:${id2}`]);
      await expect(stageNextSiteMasterKey(paths())).rejects.toThrow(
        "already staged",
      );
      // What K2 encrypts after activation, K1-active processes can decrypt.
      const derived = deriveSiteMasterKeyring(
        await getSiteMasterKeyring(paths()),
        "secret-settings:v1",
      );
      expect(derived.map(({ id }) => id)).toEqual([id1, id2]);

      const step = await activateSiteMasterKey(id2, paths());
      expect(step.active_id).toBe(id2);
      expect(step.previous_id).toBe(id1);
      expect(await ids()).toEqual([`active:${id2}`, `retired:${id1}`]);
      expect(
        Buffer.from(
          (await readFile(keyPath(), "utf8")).trim(),
          "base64",
        ).equals(k2),
      ).toBe(true);
      expect((await stat(`${keyPath()}.keyring`)).mode & 0o777).toBe(0o600);

      // Roll back, then forward again.
      await activateSiteMasterKey(id1, paths());
      expect(await ids()).toEqual([`active:${id1}`, `retired:${id2}`]);
      await activateSiteMasterKey(id2, paths());
      expect(await ids()).toEqual([`active:${id2}`, `retired:${id1}`]);

      await expect(retireSiteMasterKey(id2, paths())).rejects.toThrow(
        "is the active key",
      );
      await retireSiteMasterKey(id1, paths());
      expect(await ids()).toEqual([`active:${id2}`]);
    });

    it("completes an activation interrupted after the key file changed", async () => {
      const k1 = await getOrCreateSiteMasterKey(paths());
      const { id: id2, key: k2 } = await stageNextSiteMasterKey(paths());
      // Simulate the crash: K1 already recorded as retired and the active file
      // switched, but K2 not yet removed from the keyring.
      const keyring = await readFile(`${keyPath()}.keyring`, "utf8");
      await writeFile(
        `${keyPath()}.keyring`,
        `${keyring}${k1.toString("base64")} retired ${siteMasterKeyId(k1)}\n`,
        { mode: 0o600 },
      );
      await writeFile(keyPath(), k2.toString("base64"), { mode: 0o600 });
      await activateSiteMasterKey(id2, paths());
      expect(await ids()).toEqual([
        `active:${id2}`,
        `retired:${siteMasterKeyId(k1)}`,
      ]);
    });

    it("rejects a keyring line whose recorded id does not match its key", () => {
      const key = Buffer.alloc(32, 3);
      expect(() =>
        parseSiteMasterKeyring(`${key.toString("base64")} retired smk_wrong`),
      ).toThrow("does not match");
      expect(() =>
        parseSiteMasterKeyring(`${key.toString("base64")} active`),
      ).toThrow('role must be "next" or "retired"');
    });

    it("refuses to rotate a read-only systemd credential", async () => {
      const credentialsDir = join(dir, "credentials");
      await mkdir(credentialsDir);
      await writeFile(
        join(credentialsDir, SITE_MASTER_KEY_CREDENTIAL_NAME),
        Buffer.alloc(32, 4).toString("base64"),
      );
      process.env[SYSTEMD_CREDENTIALS_DIRECTORY_ENV] = credentialsDir;
      await expect(stageNextSiteMasterKey(paths())).rejects.toThrow(
        "read-only systemd credential",
      );
    });

    it("decrypts with whichever key worked, preferring the named one", () => {
      const keys = [
        { id: "a", role: "active" as const, key: Buffer.alloc(32, 1) },
        { id: "b", role: "retired" as const, key: Buffer.alloc(32, 2) },
      ];
      const only = (want: number) => (key: Buffer) => {
        if (key[0] !== want) throw new Error("wrong key");
        return want;
      };
      expect(decryptWithAnyKey(keys, only(2)).key.id).toBe("b");
      expect(decryptWithAnyKey(keys, only(1), "b").key.id).toBe("a");
      expect(() => decryptWithAnyKey(keys, only(9))).toThrow("wrong key");
    });

    it("records which key a backup holds", async () => {
      await getOrCreateSiteMasterKey(paths());
      const { id, key } = await stageNextSiteMasterKey(paths());
      const backup = await createSiteMasterKeyBackup({
        paths: paths(),
        plaintext: true,
        key,
      });
      expect(backup.encrypted).toBe(false);
      if (!backup.encrypted) expect(backup.key.key_id).toBe(id);
    });
  });
});
