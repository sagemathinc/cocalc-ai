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

  it("redirects My Agents urls into the app shell", async () => {
    const response = await request("/agents/agent-123");
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/static/app.html?target=");
    const redirected = new URL(`http://host${location}`);
    expect(redirected.searchParams.get("target")).toBe("/agents/agent-123");
  });

  it.each([
    "/artifacts",
    "/artifacts/",
    "/artifacts/sphere",
    "/artifacts/project-1/entry-1?view=grid",
  ])("redirects direct artifact URL %s into the app shell", async (path) => {
    const response = await request(path);
    expect(response.status).toBe(302);
    const redirected = new URL(
      `http://host${response.headers.get("location")}`,
    );
    expect(redirected.pathname).toBe("/static/app.html");
    expect(redirected.searchParams.get("target")).toBe(path);
  });

  it.each(["/library", "/library/sphere", "/library/project-1/entry-1"])(
    "leaves removed library route %s unregistered",
    async (path) => {
      expect((await request(path)).status).toBe(404);
    },
  );

  it.each([
    "/collaborators",
    "/home",
    "/home/",
    "/collaborators/",
    "/collaborators/conversations",
    "/collaborators/people",
    "/collaborators/projects",
    "/collaborators/conversations/project/project-1/person/person-1/resource/conversation/thread-1",
    "/collaborators/projects/project/project-1/resource/artifact/folder%2Fitem?foo=bar&label=a%20b",
  ])(
    "redirects direct Collaborators URL %s into the app shell",
    async (path) => {
      const response = await request(path);
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).toContain("/static/app.html?target=");
      const redirected = new URL(`http://host${location}`);
      expect(redirected.searchParams.get("target")).toBe(path);
    },
  );
});
