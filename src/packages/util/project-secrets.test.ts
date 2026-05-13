import { randomBytes } from "node:crypto";

import {
  decryptProjectSecretValue,
  encryptProjectSecretValue,
  normalizeProjectSecretName,
  PROJECT_ENV_MAX_COUNT,
  PROJECT_ENV_TOTAL_MAX_BYTES,
  PROJECT_ENV_VALUE_MAX_BYTES,
  PROJECT_SECRETS_ENV,
  validateProjectEnv,
  validateProjectSecretValue,
} from "./project-secrets";

describe("project-secrets", () => {
  const key = randomBytes(32);
  const project_id = "11111111-1111-4111-8111-111111111111";

  it("round trips secret values bound to project id and name", () => {
    const encrypted = encryptProjectSecretValue({
      project_id,
      name: "GITHUB_DEPLOY_KEY",
      value: "private-key",
      key,
    });

    expect(
      decryptProjectSecretValue({
        project_id,
        name: "GITHUB_DEPLOY_KEY",
        encrypted,
        key,
      }),
    ).toBe("private-key");
    expect(() =>
      decryptProjectSecretValue({
        project_id: "22222222-2222-4222-8222-222222222222",
        name: "GITHUB_DEPLOY_KEY",
        encrypted,
        key,
      }),
    ).toThrow();
    expect(() =>
      decryptProjectSecretValue({
        project_id,
        name: "OTHER",
        encrypted,
        key,
      }),
    ).toThrow();
  });

  it("validates secret names and values", () => {
    expect(normalizeProjectSecretName("ssh.key-1")).toBe("ssh.key-1");
    expect(() => normalizeProjectSecretName("../secret")).toThrow();
    expect(() => normalizeProjectSecretName("bad/name")).toThrow();
    expect(() => validateProjectSecretValue("x".repeat(64 * 1024 + 1))).toThrow(
      "too large",
    );
  });

  it("validates project environment caps and reserved names", () => {
    expect(() => validateProjectEnv({ PATH: "/usr/bin" })).not.toThrow();
    expect(() =>
      validateProjectEnv({ [PROJECT_SECRETS_ENV]: "/tmp/nope" }),
    ).toThrow("managed by CoCalc");
    expect(() => validateProjectEnv({ COCALC_TOKEN: "x" })).toThrow("reserved");
    expect(() => validateProjectEnv({ "bad-key": "x" })).toThrow("invalid");
    expect(() => validateProjectEnv({ OK: 12 as any })).toThrow(
      "must be a string",
    );
    expect(() =>
      validateProjectEnv({
        TOO_BIG: "x".repeat(PROJECT_ENV_VALUE_MAX_BYTES + 1),
      }),
    ).toThrow("too large");
    expect(() =>
      validateProjectEnv({
        ...Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [
            `TOTAL_${i}`,
            "x".repeat(Math.floor(PROJECT_ENV_TOTAL_MAX_BYTES / 8)),
          ]),
        ),
      }),
    ).toThrow("too large");
    expect(() =>
      validateProjectEnv(
        Object.fromEntries(
          Array.from({ length: PROJECT_ENV_MAX_COUNT + 1 }, (_, i) => [
            `K${i}`,
            "v",
          ]),
        ),
      ),
    ).toThrow("too many");
  });
});
