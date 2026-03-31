import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProjectHostBootstrapConatSource,
  getProjectHostBootstrapToken,
} from "./master-conat-token";

function withBootstrapEnv<T>(bootstrapDir: string, fn: () => T): T {
  const envKeys = [
    "COCALC_PROJECT_HOST_BOOTSTRAP_DIR",
    "COCALC_BOOTSTRAP_CONFIG_PATH",
    "COCALC_PROJECT_HOST_BOOTSTRAP_TOKEN",
    "COCALC_PROJECT_HOST_BOOTSTRAP_CONAT_URL",
    "COCALC_PROJECT_HOST_BOOTSTRAP_MASTER_CONAT_URL",
    "COCALC_PROJECT_HOST_BOOTSTRAP_CA_CERT_PATH",
  ] as const;
  const previous = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof envKeys)[number], string | undefined>;
  process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR = bootstrapDir;
  delete process.env.COCALC_BOOTSTRAP_CONFIG_PATH;
  delete process.env.COCALC_PROJECT_HOST_BOOTSTRAP_TOKEN;
  delete process.env.COCALC_PROJECT_HOST_BOOTSTRAP_CONAT_URL;
  delete process.env.COCALC_PROJECT_HOST_BOOTSTRAP_MASTER_CONAT_URL;
  delete process.env.COCALC_PROJECT_HOST_BOOTSTRAP_CA_CERT_PATH;
  try {
    return fn();
  } finally {
    for (const key of envKeys) {
      const value = previous[key];
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("master-conat-token bootstrap source", () => {
  it("prefers split desired-state bootstrap connection over legacy config", () => {
    const root = mkdtempSync(join(tmpdir(), "cocalc-bootstrap-"));
    const bootstrapDir = join(root, "bootstrap");
    mkdirSync(bootstrapDir, { recursive: true });
    writeFileSync(
      join(bootstrapDir, "bootstrap-desired-state.json"),
      JSON.stringify(
        {
          bootstrap_connection: {
            bootstrap_token: "split-token",
            conat_url: "https://split.example.invalid/master-token",
            ca_cert_path: "/split/ca.pem",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(bootstrapDir, "bootstrap-config.json"),
      JSON.stringify(
        {
          bootstrap_token: "legacy-token",
          conat_url: "https://legacy.example.invalid/master-token",
          ca_cert_path: "/legacy/ca.pem",
        },
        null,
        2,
      ),
    );

    withBootstrapEnv(bootstrapDir, () => {
      expect(getProjectHostBootstrapToken()).toBe("split-token");
      expect(getProjectHostBootstrapConatSource()).toEqual({
        bootstrap_token: "split-token",
        conat_url: "https://split.example.invalid/master-token",
        ca_cert_path: "/split/ca.pem",
      });
    });
  });

  it("falls back to bootstrap-config when split desired state is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "cocalc-bootstrap-"));
    const bootstrapDir = join(root, "bootstrap");
    mkdirSync(bootstrapDir, { recursive: true });
    writeFileSync(
      join(bootstrapDir, "bootstrap-config.json"),
      JSON.stringify(
        {
          bootstrap_token: "legacy-token",
          conat_url: "https://legacy.example.invalid/master-token",
        },
        null,
        2,
      ),
    );

    withBootstrapEnv(bootstrapDir, () => {
      expect(getProjectHostBootstrapToken()).toBe("legacy-token");
      expect(
        getProjectHostBootstrapConatSource({
          fallbackConatUrl: "https://fallback.example.invalid/master-token",
        }),
      ).toEqual({
        bootstrap_token: "legacy-token",
        conat_url: "https://legacy.example.invalid/master-token",
      });
    });
  });
});
