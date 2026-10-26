import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicKey, generateKeyPairSync } from "node:crypto";

function normalize(publicKey: string): string {
  return `${createPublicKey(publicKey).export({ type: "spki", format: "pem" })}`.trim();
}

describe("project-host auth public key cache", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.COCALC_PROJECT_HOST_AUTH_TOKEN_PUBLIC_KEY;
    delete process.env.COCALC_PROJECT_HOST_AUTH_TOKEN_PUBLIC_KEY_PATH;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("persists the distributed key for restarted child processes", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-auth-key-"),
    );
    const publicKeyPath = path.join(
      dir,
      "project-host-auth-ed25519-public.pem",
    );
    const { publicKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }) as { publicKey: string; privateKey: string };
    process.env.COCALC_PROJECT_HOST_AUTH_TOKEN_PUBLIC_KEY_PATH = publicKeyPath;

    const mod1 = await import("./auth-public-key");
    mod1.setProjectHostAuthPublicKey(publicKey);
    await mod1.flushProjectHostAuthPublicKey();
    expect(fs.readFileSync(publicKeyPath, "utf8").trim()).toBe(
      normalize(publicKey),
    );

    jest.resetModules();
    process.env = {
      ...originalEnv,
      COCALC_PROJECT_HOST_AUTH_TOKEN_PUBLIC_KEY_PATH: publicKeyPath,
    };
    const mod2 = await import("./auth-public-key");
    expect(mod2.getProjectHostAuthPublicKey()).toBe(normalize(publicKey));
  });

  it("writes the file only when the key changes, without blocking", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-auth-key-"),
    );
    const publicKeyPath = path.join(
      dir,
      "project-host-auth-ed25519-public.pem",
    );
    process.env.COCALC_PROJECT_HOST_AUTH_TOKEN_PUBLIC_KEY_PATH = publicKeyPath;
    const key = () =>
      (
        generateKeyPairSync("ed25519", {
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        }) as { publicKey: string }
      ).publicKey;
    const first = key();
    const second = key();
    const writeFileSync = jest.spyOn(fs, "writeFileSync");
    const mod = await import("./auth-public-key");

    mod.setProjectHostAuthPublicKey(first);
    // In memory at once, on disk shortly after.
    expect(mod.getProjectHostAuthPublicKey()).toBe(normalize(first));
    await mod.flushProjectHostAuthPublicKey();
    const written = fs.statSync(publicKeyPath).mtimeMs;
    expect(fs.readFileSync(publicKeyPath, "utf8").trim()).toBe(
      normalize(first),
    );

    // The same key again (every host's registration repeats it): no write.
    fs.utimesSync(publicKeyPath, new Date(0), new Date(0));
    for (let i = 0; i < 5; i++) mod.setProjectHostAuthPublicKey(first);
    await mod.flushProjectHostAuthPublicKey();
    expect(fs.statSync(publicKeyPath).mtimeMs).toBe(0);
    expect(written).toBeGreaterThan(0);

    // A new key is written.
    mod.setProjectHostAuthPublicKey(second);
    await mod.flushProjectHostAuthPublicKey();
    expect(fs.readFileSync(publicKeyPath, "utf8").trim()).toBe(
      normalize(second),
    );
    expect(mod.getProjectHostAuthPublicKey()).toBe(normalize(second));
    // Never synchronously.
    expect(writeFileSync).not.toHaveBeenCalledWith(
      publicKeyPath,
      expect.anything(),
      expect.anything(),
    );
    writeFileSync.mockRestore();
  });

  it("ignores an invalid key and keeps the last good one", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-project-host-auth-key-"),
    );
    process.env.COCALC_PROJECT_HOST_AUTH_TOKEN_PUBLIC_KEY_PATH = path.join(
      dir,
      "key.pem",
    );
    const { publicKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }) as { publicKey: string };
    const mod = await import("./auth-public-key");
    mod.setProjectHostAuthPublicKey(publicKey);
    mod.setProjectHostAuthPublicKey("not a key");
    await mod.flushProjectHostAuthPublicKey();
    expect(mod.getProjectHostAuthPublicKey()).toBe(normalize(publicKey));
  });
});
