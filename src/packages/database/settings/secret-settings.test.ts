const readFileMock = jest.fn();
const writeFileMock = jest.fn();
const mkdirMock = jest.fn();
const accessMock = jest.fn();
const chmodMock = jest.fn();
const keyPathDefault = "/tmp/secrets/site-master-key";
const keyPathCustom = "/tmp/custom/settings-key";

jest.mock("node:fs/promises", () => ({
  access: (...args: any[]) => accessMock(...args),
  chmod: (...args: any[]) => chmodMock(...args),
  mkdir: (...args: any[]) => mkdirMock(...args),
  readFile: (...args: any[]) => readFileMock(...args),
  writeFile: (...args: any[]) => writeFileMock(...args),
}));

jest.mock("@cocalc/backend/data", () => ({
  secrets: "/tmp/secrets",
}));

describe("secret-settings key handling", () => {
  beforeEach(() => {
    accessMock.mockReset();
    chmodMock.mockReset();
    mkdirMock.mockReset();
    readFileMock.mockReset();
    // No rotation keyring unless a test provides one.
    readFileMock.mockImplementation(async (path: string) => {
      throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
    });
    writeFileMock.mockReset();
    jest.resetModules();
    delete process.env.COCALC_SITE_MASTER_KEY_PATH;
    delete process.env.COCALC_SECRET_SETTINGS_KEY_PATH;
  });

  it("creates key file when missing", async () => {
    const { getSecretSettingsKey } = await import("./secret-settings");
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    readFileMock.mockRejectedValueOnce(missing);
    accessMock.mockRejectedValueOnce(missing);
    const key = await getSecretSettingsKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(writeFileMock).toHaveBeenCalledWith(
      keyPathDefault,
      expect.any(String),
      { mode: 0o600 },
    );
  });

  it("rejects invalid key length", async () => {
    const { getSecretSettingsKey } = await import("./secret-settings");
    readFileMock.mockResolvedValueOnce("short-key");
    await expect(getSecretSettingsKey()).rejects.toThrow(
      "invalid master key length",
    );
  });

  it("honors custom key path env var", async () => {
    process.env.COCALC_SITE_MASTER_KEY_PATH = keyPathCustom;
    const { getSecretSettingsKey } = await import("./secret-settings");
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    readFileMock.mockRejectedValueOnce(missing);
    accessMock.mockRejectedValueOnce(missing);
    await getSecretSettingsKey();
    expect(writeFileMock).toHaveBeenCalledWith(
      keyPathCustom,
      expect.any(String),
      { mode: 0o600 },
    );
  });

  it("decrypts values under a retired key and asks for them to be migrated", async () => {
    const { deriveSiteMasterKey, siteMasterKeyId } =
      await import("@cocalc/util/master-key-lifecycle");
    const { encryptSecretSettingValue } =
      await import("@cocalc/util/secret-settings-crypto");
    const active = Buffer.alloc(32, 1);
    const retired = Buffer.alloc(32, 2);
    readFileMock.mockImplementation(async (path: string) => {
      if (path === keyPathDefault) return active.toString("base64");
      if (path === `${keyPathDefault}.keyring`) {
        return `${retired.toString("base64")} retired ${siteMasterKeyId(retired)} 2026-10-08T00:00:00.000Z\n`;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const settings = await import("./secret-settings");
    const keys = await settings.getSecretSettingsKeys();
    expect(keys.map(({ id, role }) => [id, role])).toEqual([
      [siteMasterKeyId(active), "active"],
      [siteMasterKeyId(retired), "retired"],
    ]);
    const old = encryptSecretSettingValue(
      "name",
      "value",
      deriveSiteMasterKey(retired, "secret-settings:v1"),
      siteMasterKeyId(retired),
    );
    await expect(
      settings.decryptSecretStorageValue("name", old),
    ).resolves.toEqual({
      value: "value",
      needsMigration: true,
    });
    // New values use the active key and name it.
    const fresh = await settings.encryptSecretStorageValue("name", "value");
    expect(fresh).toContain(`:${siteMasterKeyId(active)}:`);
    await expect(
      settings.decryptSecretStorageValue("name", fresh),
    ).resolves.toEqual({
      value: "value",
      needsMigration: false,
    });
    // Keyed hashes are matched under both keys, the active key's first.
    const candidates = await settings.secretSettingsHmacCandidates((key) =>
      key.toString("hex").slice(0, 8),
    );
    expect(candidates).toEqual([
      deriveSiteMasterKey(active, "secret-settings:v1")
        .toString("hex")
        .slice(0, 8),
      deriveSiteMasterKey(retired, "secret-settings:v1")
        .toString("hex")
        .slice(0, 8),
    ]);
  });
});
