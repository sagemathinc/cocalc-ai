import type { AddressInfo } from "node:net";
import express from "express";
import initPublicFeatures from "./public-features";

jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(async () => ({ siteName: "CoCalc" })),
}));

jest.mock("@cocalc/database/postgres/news", () => ({
  getNewsItem: jest.fn(async () => null),
}));

jest.mock("@cocalc/server/auth/get-account", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/rootfs/catalog", () => ({
  listVisibleRootfsImages: jest.fn(async () => ({
    version: 1,
    images: [
      {
        id: "rootfs-image-1",
        label: "Test Image",
        image: "registry.example.com/cocalc/rootfs-image-1",
      },
    ],
  })),
}));

describe("public feature and docs routes", () => {
  async function request(path: string) {
    const app = express();
    const router = express.Router();
    initPublicFeatures(router);
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

  it("serves feature pages from clean URLs", async () => {
    const response = await request("/features/python?x=1");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("vary")).toContain("Host");
    expect(body).toContain('data-cocalc-public-route-meta="canonical"');
    expect(body).toContain('/features/python" rel="canonical"');
  });

  it("serves docs pages with per-entry canonical metadata", async () => {
    const response = await request("/docs/projects/project-secrets?x=1");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(body).toContain(
      "<title>Project secrets - Documentation | CoCalc</title>",
    );
    expect(body).toContain('/docs/projects/project-secrets" rel="canonical"');
  });

  it("serves rootfs image pages from clean URLs", async () => {
    const response = await request("/rootfs/id/rootfs-image-1?x=1");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(body).toContain('/rootfs/id/rootfs-image-1" rel="canonical"');
  });

  it("responds 404 for rootfs images that are not in the catalog", async () => {
    const response = await request("/rootfs/id/this-does-not-exist");
    expect(response.status).toBe(404);
  });
});
