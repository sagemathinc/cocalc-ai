import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import express from "express";
import initSoftwareRoutes, {
  getBundleVersionInfo,
} from "./project-host-software";

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(async () => ({
    project_hosts_software_base_url: "https://software.cocalc.ai/software",
  })),
}));

describe("project-host local software versioning", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "project-host-software-"));
  });

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers project-host build identity over tarball mtime", async () => {
    const buildDir = join(root, "project-host", "build");
    const bundleDir = join(buildDir, "bundle");
    await mkdir(bundleDir, { recursive: true });
    const bundlePath = join(buildDir, "bundle-linux.tar.xz");
    await writeFile(bundlePath, "bundle");
    await writeFile(
      join(bundleDir, "build-identity.json"),
      JSON.stringify(
        {
          build_id: "20260503T191857Z-1d5c108b5bbf-dirty-e3b0c442",
          built_at: "2026-05-03T19:18:57.000Z",
        },
        null,
        2,
      ),
    );
    const info = await getBundleVersionInfo(bundlePath, "project-host");
    expect(info.version).toBe("20260503T191857Z-1d5c108b5bbf-dirty-e3b0c442");
    expect(info.builtAt).toBe("2026-05-03T19:18:57.000Z");
  });

  it("keeps mtime-based versioning for non-project-host artifacts", async () => {
    const buildDir = join(root, "project", "build");
    await mkdir(buildDir, { recursive: true });
    const bundlePath = join(buildDir, "bundle-linux.tar.xz");
    await writeFile(bundlePath, "bundle");
    const info = await getBundleVersionInfo(bundlePath, "project");
    expect(info.version).toMatch(/^\d+$/);
  });
});

describe("container-runtime software proxy", () => {
  const previousEndpointMode =
    process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE;
  const previousContainerRuntimeBaseUrl =
    process.env.COCALC_PROJECT_HOST_CONTAINER_RUNTIME_SOFTWARE_BASE_URL;

  beforeAll(() => {
    process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE = "remote";
    delete process.env.COCALC_PROJECT_HOST_CONTAINER_RUNTIME_SOFTWARE_BASE_URL;
  });

  afterAll(() => {
    if (previousEndpointMode == null) {
      delete process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE;
    } else {
      process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE =
        previousEndpointMode;
    }
    if (previousContainerRuntimeBaseUrl == null) {
      delete process.env
        .COCALC_PROJECT_HOST_CONTAINER_RUNTIME_SOFTWARE_BASE_URL;
    } else {
      process.env.COCALC_PROJECT_HOST_CONTAINER_RUNTIME_SOFTWARE_BASE_URL =
        previousContainerRuntimeBaseUrl;
    }
  });

  async function request(path: string) {
    const app = express();
    const router = express.Router();
    initSoftwareRoutes(router);
    app.use(router);
    const server = await new Promise<ReturnType<typeof app.listen>>(
      (resolve) => {
        const next = app.listen(0, "127.0.0.1", () => resolve(next));
      },
    );
    try {
      const { port } = server.address() as AddressInfo;
      return await fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: "manual",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  it("redirects architecture-specific runtime catalogs", async () => {
    const response = await request(
      "/software/container-runtime/latest-linux-amd64.json",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://software.cocalc.ai/software/container-runtime/latest-linux-amd64.json",
    );
  });

  it("redirects immutable runtime archives and checksums", async () => {
    const path =
      "/software/container-runtime/runtime-v2/container-runtime-linux-amd64.tar.xz.sha256";
    const response = await request(path);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://software.cocalc.ai/software${path.slice("/software".length)}`,
    );
  });

  it.each(["amd64", "arm64"])(
    "redirects pinned managed harnesses for %s",
    async (arch) => {
      const path = `/software/harnesses/claude-code/0.81.1/${"a".repeat(64)}/harnesses-linux-${arch}.tar.xz`;
      const response = await request(path);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `https://software.cocalc.ai/software${path.slice("/software".length)}`,
      );
    },
  );

  it.each([
    ["not-a-hash", "amd64"],
    ["a".repeat(64), "s390x"],
  ])(
    "rejects invalid managed harness selectors (%s, %s)",
    async (hash, arch) => {
      const response = await request(
        `/software/harnesses/claude-code/0.81.1/${hash}/harnesses-linux-${arch}.tar.xz`,
      );
      expect(response.status).toBe(404);
    },
  );

  it("serves only the matching pinned archive in local mode without remote fallback", async () => {
    const previousRoot = process.env.COCALC_PROJECT_HOST_SOFTWARE_PACKAGES_ROOT;
    const root = await mkdtemp(join(tmpdir(), "managed-harness-software-"));
    process.env.COCALC_PROJECT_HOST_SOFTWARE_PACKAGES_ROOT = root;
    process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE = "local";
    try {
      await mkdir(join(root, "project-host", "build"), { recursive: true });
      await mkdir(join(root, "project", "build"), { recursive: true });
      await mkdir(join(root, "server", "cloud", "bootstrap"), {
        recursive: true,
      });
      const body = "pinned harness fixture";
      const sha = createHash("sha256").update(body).digest("hex");
      await writeFile(
        join(root, "project", "build", "harnesses-linux-amd64.tar.xz"),
        body,
      );
      const response = await request(
        `/software/harnesses/claude-code/0.81.1/${sha}/harnesses-linux-amd64.tar.xz`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
      const missing = await request(
        `/software/harnesses/claude-code/0.81.1/${"0".repeat(64)}/harnesses-linux-amd64.tar.xz`,
      );
      expect(missing.status).toBe(404);
      expect(missing.headers.get("location")).toBeNull();
    } finally {
      if (previousRoot == null)
        delete process.env.COCALC_PROJECT_HOST_SOFTWARE_PACKAGES_ROOT;
      else
        process.env.COCALC_PROJECT_HOST_SOFTWARE_PACKAGES_ROOT = previousRoot;
      process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE = "remote";
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports an explicit container-runtime fallback in local mode", async () => {
    process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE = "local";
    process.env.COCALC_PROJECT_HOST_CONTAINER_RUNTIME_SOFTWARE_BASE_URL =
      "https://runtime.example.test/software";
    try {
      const path = "/software/container-runtime/latest-linux-amd64.json";
      const response = await request(path);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `https://runtime.example.test/software${path.slice("/software".length)}`,
      );
    } finally {
      process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE = "remote";
      delete process.env
        .COCALC_PROJECT_HOST_CONTAINER_RUNTIME_SOFTWARE_BASE_URL;
    }
  });

  it("keeps local mode air-gapped without an explicit fallback", async () => {
    process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE = "local";
    try {
      const response = await request(
        "/software/container-runtime/latest-linux-amd64.json",
      );

      expect(response.status).toBe(404);
    } finally {
      process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE = "remote";
    }
  });
});
