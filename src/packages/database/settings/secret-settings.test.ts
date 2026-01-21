const readFileMock = jest.fn();
const writeFileMock = jest.fn();
const keyPathDefault = "/tmp/secrets/server-settings-key";
const keyPathCustom = "/tmp/custom/settings-key";

jest.mock("node:fs/promises", () => ({
  readFile: (...args: any[]) => readFileMock(...args),
  writeFile: (...args: any[]) => writeFileMock(...args),
}));

jest.mock("@cocalc/backend/data", () => ({
  secrets: "/tmp/secrets",
}));

describe("secret-settings key handling", () => {
  beforeEach(() => {
    readFileMock.mockReset();
    writeFileMock.mockReset();
    jest.resetModules();
    delete process.env.COCALC_SECRET_SETTINGS_KEY_PATH;
  });

  it("creates key file when missing", async () => {
    const { getSecretSettingsKey } = await import("./secret-settings");
    readFileMock.mockRejectedValueOnce(new Error("missing"));
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
      "invalid secret settings key length",
    );
  });

  it("honors custom key path env var", async () => {
    process.env.COCALC_SECRET_SETTINGS_KEY_PATH = keyPathCustom;
    const { getSecretSettingsKey } = await import("./secret-settings");
    readFileMock.mockRejectedValueOnce(new Error("missing"));
    await getSecretSettingsKey();
    expect(writeFileMock).toHaveBeenCalledWith(
      keyPathCustom,
      expect.any(String),
      { mode: 0o600 },
    );
  });
});
