import type { AddressInfo } from "node:net";
import express from "express";
import initPublicAuth from "./public-auth";

describe("public auth routes", () => {
  async function request(path: string) {
    const app = express();
    const router = express.Router();
    initPublicAuth(router);
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

  it("redirects CLI login approval routes into the public auth shell", async () => {
    const response = await request("/auth/cli-login/challenge-123?x=1");
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/static/public.html?target=");
    const redirected = new URL(`http://host${location}`);
    expect(redirected.searchParams.get("target")).toBe(
      "/auth/cli-login/challenge-123?x=1",
    );
  });

  it("redirects CLI elevation approval routes into the public auth shell", async () => {
    const response = await request("/auth/cli-elevate/challenge-456");
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/static/public.html?target=");
    const redirected = new URL(`http://host${location}`);
    expect(redirected.searchParams.get("target")).toBe(
      "/auth/cli-elevate/challenge-456",
    );
  });
});
