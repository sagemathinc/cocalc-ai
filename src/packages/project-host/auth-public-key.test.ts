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
});
