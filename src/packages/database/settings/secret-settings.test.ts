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
});
