import type { AddressInfo } from "node:net";
import express from "express";
import initPublicFeatures from "./public-features";

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

  it("redirects feature pages into the public shell", async () => {
    const response = await request("/features/python?x=1");
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/static/public.html?target=");
    const redirected = new URL(`http://host${location}`);
    expect(redirected.searchParams.get("target")).toBe("/features/python?x=1");
  });

  it("redirects docs pages into the public shell", async () => {
    const response = await request("/docs/projects/project-secrets?x=1");
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/static/public.html?target=");
    const redirected = new URL(`http://host${location}`);
    expect(redirected.searchParams.get("target")).toBe(
      "/docs/projects/project-secrets?x=1",
    );
  });

  it("redirects rootfs image pages into the public shell", async () => {
    const response = await request("/rootfs/id/rootfs-image-1?x=1");
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/static/public.html?target=");
    const redirected = new URL(`http://host${location}`);
    expect(redirected.searchParams.get("target")).toBe(
      "/rootfs/id/rootfs-image-1?x=1",
    );
  });
});
