import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  beforeAll(() => {
    process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE = "remote";
  });

  afterAll(() => {
    if (previousEndpointMode == null) {
      delete process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE;
    } else {
      process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE =
        previousEndpointMode;
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
});
