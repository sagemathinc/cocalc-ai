/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let getServerSettingsMock: jest.Mock;

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: unknown[]) => getServerSettingsMock(...args),
}));

const ENV_KEYS = [
  "COCALC_BLOB_STORAGE_BACKEND",
  "COCALC_BLOB_R2_ACCOUNT_ID",
  "COCALC_BLOB_R2_ENDPOINT",
  "COCALC_BLOB_R2_ACCESS_KEY_ID",
  "COCALC_BLOB_R2_SECRET_ACCESS_KEY",
  "COCALC_BLOB_R2_BUCKET",
  "COCALC_BLOB_R2_PUBLIC_URL",
  "COCALC_BLOB_R2_REGION",
];

describe("blob storage config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    getServerSettingsMock = jest.fn(async () => ({}));
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("defaults to PostgreSQL storage", async () => {
    const { resolveBlobStorageConfig } = await import("./config");
    await expect(resolveBlobStorageConfig()).resolves.toMatchObject({
      backend: "postgres",
      activeBackend: "postgres",
    });
  });

  it("uses fully specified environment R2 config without querying settings", async () => {
    process.env.COCALC_BLOB_STORAGE_BACKEND = "r2";
    process.env.COCALC_BLOB_R2_ACCOUNT_ID = "account";
    process.env.COCALC_BLOB_R2_ACCESS_KEY_ID = "access";
    process.env.COCALC_BLOB_R2_SECRET_ACCESS_KEY = "secret";
    process.env.COCALC_BLOB_R2_BUCKET = "prod-blobs";
    process.env.COCALC_BLOB_R2_PUBLIC_URL = "https://blobs.example.com/";

    const { resolveBlobStorageConfig } = await import("./config");
    await expect(resolveBlobStorageConfig()).resolves.toMatchObject({
      backend: "r2",
      activeBackend: "r2",
      r2: {
        auth: {
          endpoint: "https://account.r2.cloudflarestorage.com",
          accessKey: "access",
          secretKey: "secret",
          bucket: "prod-blobs",
        },
        publicBaseUrl: "https://blobs.example.com",
      },
    });
    expect(getServerSettingsMock).not.toHaveBeenCalled();
  });

  it("uses site settings and derives bucket fallback from r2_bucket_prefix", async () => {
    getServerSettingsMock.mockResolvedValue({
      blob_storage_backend: "auto",
      r2_account_id: "account",
      r2_access_key_id: "access",
      r2_secret_access_key: "secret",
      r2_bucket_prefix: "staging",
      blob_r2_public_url: "https://blobs.example.com/path/",
    });

    const { resolveBlobStorageConfig } = await import("./config");
    await expect(resolveBlobStorageConfig()).resolves.toMatchObject({
      backend: "auto",
      activeBackend: "r2",
      r2: {
        auth: { bucket: "staging-blobs" },
        publicBaseUrl: "https://blobs.example.com/path",
      },
    });
  });

  it("rejects strict R2 mode without complete settings", async () => {
    getServerSettingsMock.mockResolvedValue({
      blob_storage_backend: "r2",
      r2_account_id: "account",
    });

    const { resolveBlobStorageConfig } = await import("./config");
    await expect(resolveBlobStorageConfig()).rejects.toThrow(
      "blob_storage_backend is r2",
    );
  });

  it("gives the R2 credentials whenever they are set, whatever the backend", async () => {
    getServerSettingsMock.mockResolvedValue({
      blob_storage_backend: "postgres",
      r2_account_id: "account",
      r2_access_key_id: "access",
      r2_secret_access_key: "secret",
      r2_bucket_prefix: "staging",
    });
    const { resolveBlobR2Auth, resolveBlobStorageConfig } =
      await import("./config");
    await expect(resolveBlobStorageConfig()).resolves.toEqual({
      backend: "postgres",
      activeBackend: "postgres",
    });
    await expect(resolveBlobR2Auth()).resolves.toMatchObject({
      endpoint: "https://account.r2.cloudflarestorage.com",
      bucket: "staging-blobs",
    });
    getServerSettingsMock.mockResolvedValue({ r2_account_id: "account" });
    await expect(resolveBlobR2Auth()).resolves.toBeUndefined();
  });
});
