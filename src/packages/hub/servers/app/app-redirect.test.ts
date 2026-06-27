import type { AddressInfo } from "node:net";
import express from "express";
import initAppRedirect from "./app-redirect";

describe("app redirect routes", () => {
  async function request(path: string) {
    const app = express();
    const router = express.Router();
    initAppRedirect(router);
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

  it("redirects public directory share urls into the app shell", async () => {
    const response = await request("/share/x?foo=bar");
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/static/app.html?target=");
    const redirected = new URL(`http://host${location}`);
    expect(redirected.searchParams.get("target")).toBe("/share/x?foo=bar");
  });
});
