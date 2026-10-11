import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  readdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  activateSiteMasterKey,
  addRetiredSiteMasterKey,
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
      await retireSiteMasterKey(id1, { ...paths(), force: true });
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
        `${keyring}${k1.toString("base64")} retired ${siteMasterKeyId(k1)} 2026-10-08T00:00:00.000Z\n`,
        { mode: 0o600 },
      );
      await writeFile(keyPath(), k2.toString("base64"), { mode: 0o600 });
      await activateSiteMasterKey(id2, paths());
      expect(await ids()).toEqual([
        `active:${id2}`,
        `retired:${siteMasterKeyId(k1)}`,
      ]);
    });

    it("accepts only the exact keyring line format", () => {
      const key = Buffer.alloc(32, 3);
      const b64 = key.toString("base64");
      const id = siteMasterKeyId(key);
      const when = "2026-10-08T00:00:00.000Z";
      const other = Buffer.alloc(32, 4);
      expect(
        parseSiteMasterKeyring(`${b64} retired ${id} ${when}`),
      ).toHaveLength(1);
      for (const [line, message] of [
        [`${b64} retired smk_wrong ${when}`, "does not match"],
        [`${b64} active ${id} ${when}`, 'role must be "next" or "retired"'],
        [`${b64} retired ${id}`, "expected"],
        [`${b64} retired ${id} ${when} extra`, "expected"],
        [`${b64} retired ${id} yesterday`, "invalid timestamp"],
        [`${b64.replace(/=$/, "")} retired ${id} ${when}`, "canonical"],
        [
          `${b64} next ${id} ${when}\n${other.toString("base64")} next ${siteMasterKeyId(other)} ${when}`,
          "more than one next key",
        ],
      ]) {
        expect(() => parseSiteMasterKeyring(line)).toThrow(message);
      }
    });

    it("refuses to retire a key before its retirement window has passed", async () => {
      const k1 = await getOrCreateSiteMasterKey(paths());
      const { id: id2 } = await stageNextSiteMasterKey(paths());
      await activateSiteMasterKey(id2, paths());
      const id1 = siteMasterKeyId(k1);
      await expect(retireSiteMasterKey(id1, paths())).rejects.toThrow(
        "wait until",
      );
      const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
      await retireSiteMasterKey(id1, { ...paths(), now: later });
      expect(await ids()).toEqual([`active:${id2}`]);
    });

    it("stages the same key on another bay and puts an old key back", async () => {
      const k1 = await getOrCreateSiteMasterKey(paths());
      const shared = randomBytes(32);
      const { id } = await stageNextSiteMasterKey({ ...paths(), key: shared });
      // Staging the same key again is a no-op; another key is refused.
      await stageNextSiteMasterKey({ ...paths(), key: shared });
      await expect(
        stageNextSiteMasterKey({ ...paths(), key: randomBytes(32) }),
      ).rejects.toThrow("already staged");
      const old = randomBytes(32);
      await addRetiredSiteMasterKey(old, paths());
      expect(await ids()).toEqual([
        `active:${siteMasterKeyId(k1)}`,
        `next:${id}`,
        `retired:${siteMasterKeyId(old)}`,
      ]);
    });

    it("waits for a live lock in the older bare process id format", async () => {
      await getOrCreateSiteMasterKey(paths());
      const lock = `${keyPath()}.keyring.lock`;
      const holder = spawn("sleep", ["30"]);
      await writeFile(lock, `${holder.pid}\n`);
      let done = false;
      const step = addRetiredSiteMasterKey(randomBytes(32), paths()).then(
        () => (done = true),
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(done).toBe(false); // the live holder's lock was not taken
      holder.kill();
      await step;
      expect(
        (await ids()).filter((id) => id.startsWith("retired:")),
      ).toHaveLength(1);
    }, 20000);

    it("serializes key-file changes and clears a stale lock", async () => {
      await getOrCreateSiteMasterKey(paths());
      const lock = `${keyPath()}.keyring.lock`;
      // A lock left by a process that no longer exists does not block.
      await writeFile(lock, "999999999\n");
      await stageNextSiteMasterKey(paths());
      await expect(stat(lock)).rejects.toThrow();
      // Nor does one whose process id now belongs to an unrelated live
      // process: from another boot, or with a different start time.
      for (const holder of [
        { pid: process.pid, boot_id: "another-boot" },
        { pid: process.pid, start: "1" },
      ]) {
        await writeFile(lock, JSON.stringify(holder));
        await addRetiredSiteMasterKey(randomBytes(32), paths());
        await expect(stat(lock)).rejects.toThrow();
      }
      // Concurrent changes all apply.
      await Promise.all(
        [1, 2, 3].map((i) =>
          addRetiredSiteMasterKey(Buffer.alloc(32, 100 + i), paths()),
        ),
      );
      expect(
        (await ids()).filter((id) => id.startsWith("retired:")),
      ).toHaveLength(5); // the two above, then these three
    }, 20000);

    it("never exposes an empty lock file", async () => {
      await getOrCreateSiteMasterKey(paths());
      const lock = `${keyPath()}.keyring.lock`;
      // A lock created empty and written afterwards could be read as stale,
      // and removed, by a waiter in between.
      const seen = new Set<string>();
      let polling = true;
      const poll = () => {
        try {
          seen.add(readFileSync(lock, "utf8"));
        } catch {}
        if (polling) setImmediate(poll);
      };
      poll();
      try {
        for (let i = 0; i < 20; i++) {
          await addRetiredSiteMasterKey(Buffer.alloc(32, 10 + i), paths());
        }
      } finally {
        polling = false;
      }
      expect(seen.size).toBeGreaterThan(0);
      expect([...seen].filter((text) => !text.trim())).toEqual([]);
      // No lock or lock record is left behind.
      const leftovers = (await readdir(dirname(keyPath()))).filter((name) =>
        name.includes(".lock"),
      );
      expect(leftovers).toEqual([]);
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
