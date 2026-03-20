import type http from "node:http";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import type { AppRequestMatch } from "./app-public-access";
import { createProjectSandboxFilesystem } from "./file-server-sandbox-policy";
import { publicViewerHtmlForPath } from "./public-viewer";

let currentProjectFs;

jest.mock("./file-server", () => ({
  getProjectSandboxFilesystem: jest.fn(() => currentProjectFs),
}));

const { maybeHandleStaticAppRequest } =
  require("./static-apps") as typeof import("./static-apps");

class MockResponse extends Writable {
  public statusCode = 200;
  public headers: Record<string, string | number> = {};
  public body = Buffer.alloc(0);

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.body = Buffer.concat([this.body, next]);
    callback();
  }

  writeHead(statusCode: number, headers?: Record<string, string | number>) {
    this.statusCode = statusCode;
    this.headers = { ...(headers ?? {}) };
    return this;
  }

  end(chunk?: string | Buffer) {
    if (chunk != null) {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.body = Buffer.concat([this.body, next]);
    }
    super.end();
    return this;
  }
}

function makeRequest(url: string): http.IncomingMessage {
  return {
    method: "GET",
    url,
    headers: {},
    socket: {},
  } as http.IncomingMessage;
}

function makeMatch(root: string, requestPath: string): AppRequestMatch {
  return {
    spec: {
      id: "site",
      kind: "static",
      static: {
        root,
      },
    },
    localPath: `/apps/site${requestPath}`,
    requestPath,
  };
}

describe("static app serving", () => {
  const project_id = "00000000-1000-4000-8000-000000000000";

  beforeEach(() => {
    currentProjectFs = undefined;
  });

  it("uses a smaller dedicated viewer page for markdown and notebooks", () => {
    expect(publicViewerHtmlForPath("a.md")).toBe("public-viewer-md.html");
    expect(publicViewerHtmlForPath("notes/a.ipynb")).toBe(
      "public-viewer-ipynb.html",
    );
    expect(publicViewerHtmlForPath("slides/a.slides")).toBe(
      "public-viewer.html",
    );
  });

  it("serves files inside the configured root", async () => {
    const base = await mkdtemp(join(tmpdir(), "cocalc-static-apps-"));
    const home = join(base, "home");
    const rootfs = join(base, "rootfs");
    const scratch = join(base, "scratch");
    await mkdir(join(home, "public"), { recursive: true });
    await mkdir(rootfs, { recursive: true });
    await mkdir(scratch, { recursive: true });
    await writeFile(join(home, "public", "hello.txt"), "hello world");

    currentProjectFs = createProjectSandboxFilesystem({
      project_id,
      home,
      rootfs,
      scratch,
    });

    const res = new MockResponse();
    const handled = await maybeHandleStaticAppRequest({
      req: makeRequest("/hello.txt"),
      res: res as unknown as http.ServerResponse,
      project_id,
      match: makeMatch("/root/public", "/hello.txt"),
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body.toString("utf8")).toBe("hello world");
  });

  it("redirects directory roots to a trailing-slash URL", async () => {
    const base = await mkdtemp(join(tmpdir(), "cocalc-static-apps-"));
    const home = join(base, "home");
    const rootfs = join(base, "rootfs");
    const scratch = join(base, "scratch");
    await mkdir(join(home, "public", "docs"), { recursive: true });
    await mkdir(rootfs, { recursive: true });
    await mkdir(scratch, { recursive: true });
    await writeFile(
      join(home, "public", "docs", "index.html"),
      "<h1>Hello</h1>",
    );

    currentProjectFs = createProjectSandboxFilesystem({
      project_id,
      home,
      rootfs,
      scratch,
    });

    const res = new MockResponse();
    const handled = await maybeHandleStaticAppRequest({
      req: makeRequest("/docs"),
      res: res as unknown as http.ServerResponse,
      project_id,
      match: {
        ...makeMatch("/root/public", "/"),
        requestPath: "/docs",
      },
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe("/docs/");
  });

  it("does not follow symlinks outside the configured root", async () => {
    const base = await mkdtemp(join(tmpdir(), "cocalc-static-apps-"));
    const home = join(base, "home");
    const rootfs = join(base, "rootfs");
    const scratch = join(base, "scratch");
    await mkdir(join(home, "public"), { recursive: true });
    await mkdir(rootfs, { recursive: true });
    await mkdir(scratch, { recursive: true });
    await writeFile(join(home, "secret.txt"), "top secret");
    await symlink("../secret.txt", join(home, "public", "leak.txt"));

    currentProjectFs = createProjectSandboxFilesystem({
      project_id,
      home,
      rootfs,
      scratch,
    });

    const res = new MockResponse();
    const handled = await maybeHandleStaticAppRequest({
      req: makeRequest("/leak.txt"),
      res: res as unknown as http.ServerResponse,
      project_id,
      match: makeMatch("/root/public", "/leak.txt"),
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(res.body.toString("utf8")).toBe("Not found\n");
  });

  it("rejects oversized public viewer manifests before reading them", async () => {
    const base = await mkdtemp(join(tmpdir(), "cocalc-static-apps-"));
    const home = join(base, "home");
    const rootfs = join(base, "rootfs");
    const scratch = join(base, "scratch");
    await mkdir(join(home, "public"), { recursive: true });
    await mkdir(rootfs, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const largeManifest = JSON.stringify({
      version: 1,
      kind: "cocalc-public-viewer-index",
      entries: [],
      description: "x".repeat(1024 * 1024 + 32),
    });
    await writeFile(join(home, "public", "index.json"), largeManifest);

    currentProjectFs = createProjectSandboxFilesystem({
      project_id,
      home,
      rootfs,
      scratch,
    });

    const res = new MockResponse();
    const handled = await maybeHandleStaticAppRequest({
      req: makeRequest("/"),
      res: res as unknown as http.ServerResponse,
      project_id,
      match: {
        ...makeMatch("/root/public", "/"),
        spec: {
          id: "site",
          kind: "static",
          static: {
            root: "/root/public",
          },
          integration: {
            mode: "cocalc-public-viewer",
            manifest: "index.json",
            directory_listing: "manifest-only",
            file_types: [".md", ".ipynb", ".slides", ".board"],
          },
        },
      },
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(413);
    expect(res.body.toString("utf8")).toContain(
      "File exceeds maximum supported size",
    );
  });

  it("allows the central viewer origin to fetch private raw files with credentials", async () => {
    const base = await mkdtemp(join(tmpdir(), "cocalc-static-apps-"));
    const home = join(base, "home");
    const rootfs = join(base, "rootfs");
    const scratch = join(base, "scratch");
    await mkdir(join(home, "public"), { recursive: true });
    await mkdir(rootfs, { recursive: true });
    await mkdir(scratch, { recursive: true });
    await writeFile(join(home, "public", "a.md"), "# Hello\n");

    currentProjectFs = createProjectSandboxFilesystem({
      project_id,
      home,
      rootfs,
      scratch,
    });
    const previous = process.env.COCALC_PUBLIC_WEB_URL;
    process.env.COCALC_PUBLIC_WEB_URL = "https://dev.cocalc.ai";

    try {
      const req = makeRequest("/a.md?raw=1");
      req.headers.origin = "https://dev.cocalc.ai";
      const res = new MockResponse();
      const handled = await maybeHandleStaticAppRequest({
        req,
        res: res as unknown as http.ServerResponse,
        project_id,
        match: {
          ...makeMatch("/root/public", "/a.md?raw=1"),
          spec: {
            id: "site",
            kind: "static",
            static: { root: "/root/public" },
            integration: {
              mode: "cocalc-public-viewer",
              manifest: "index.json",
              directory_listing: "manifest-only",
              file_types: [".md", ".ipynb", ".slides", ".board"],
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.headers["Access-Control-Allow-Origin"]).toBe(
        "https://dev.cocalc.ai",
      );
      expect(res.headers["Access-Control-Allow-Credentials"]).toBe("true");
      expect(res.headers["Vary"]).toBe("Origin");
    } finally {
      if (previous == null) {
        delete process.env.COCALC_PUBLIC_WEB_URL;
      } else {
        process.env.COCALC_PUBLIC_WEB_URL = previous;
      }
    }
  });
});
