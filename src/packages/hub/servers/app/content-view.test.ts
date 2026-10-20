import type { AddressInfo } from "node:net";
import express from "express";

const getAccountId = jest.fn();
jest.mock("@cocalc/server/auth/get-account", () => ({
  __esModule: true,
  default: (req: any) => getAccountId(req),
}));
jest.mock("@cocalc/server/auth/remember-me", () => ({
  getRememberMeHash: () => "h".repeat(127),
}));
jest.mock("@cocalc/server/conat/api/hosts", () => ({
  issueProjectContentUrl: jest.fn(),
}));
jest.mock("@cocalc/backend/base-path", () => ({ __esModule: true, default: "/" }));
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ debug: jest.fn() }),
}));

import { contentFrameUrl, initContentView } from "./content-view";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const LINK = `https://${PROJECT.replace(/-/g, "")}.h-x.content.test/_c/CAP/files/dir/a%20b.html`;

describe("content view", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let base: string;
  const issue = jest.fn();
  beforeEach(async () => {
    issue.mockReset();
    getAccountId.mockReset();
    getAccountId.mockResolvedValue(ACCOUNT);
    issue.mockResolvedValue({ url: LINK, expires_at: 0 });
    const app = express();
    const router = express.Router();
    initContentView(router, { issue });
    app.use("/", router);
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { redirect: "manual", headers });

  it("shows the file in a sandboxed frame; the link is never the page's address", async () => {
    const res = await get(`/content-view/${PROJECT}/dir/a%20b.html?x=1`, {
      "Sec-Fetch-Dest": "document",
    });
    expect(res.status).toBe(200);
    expect(issue).toHaveBeenCalledWith({
      account_id: ACCOUNT,
      session_hash: "h".repeat(127),
      project_id: PROJECT,
      path: "/dir/a b.html",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`frame-src ${new URL(LINK).origin}`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    const html = await res.text();
    expect(html).toContain(
      'sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"',
    );
    // Set once, by the script, with the fragment appended.
    expect(html).toContain(`data-src="${LINK}?x=1"`);
    expect(html).not.toMatch(/<iframe[^>]* src=/);
    expect(html).toContain("<title>CoCalc</title>");
  });

  it("never lets the forwarded query break out of the frame's data-src", async () => {
    const res = await get(
      `/content-view/${PROJECT}/dir/a%20b.html?a=%22%3E%3Cscript%3E&b=x%26y&c=%27`,
      { "Sec-Fetch-Dest": "document" },
    );
    const html = await res.text();
    const attr = html.match(/data-src="([^"]*)"/)?.[1] ?? "";
    expect(attr.startsWith(LINK)).toBe(true);
    expect(html).not.toContain("<script>\"");
    expect(html).not.toMatch(/data-src="[^"]*"[^>]*<script>/);
    expect(html.match(/<script/g)?.length).toBe(1);
  });

  it("leaves it to the app when there is no link: signed out, no access, an API key, an error", async () => {
    const app = `/projects/${PROJECT}/files/dir/a%20b.html`;
    getAccountId.mockResolvedValueOnce(undefined);
    let res = await get(`/content-view/${PROJECT}/dir/a%20b.html`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(app);
    issue.mockResolvedValueOnce({ unavailable: "no-access" });
    res = await get(`/content-view/${PROJECT}/dir/a%20b.html`);
    expect(res.headers.get("location")).toBe(app);
    res = await get(`/content-view/${PROJECT}/dir/a%20b.html`, {
      Authorization: "Bearer key",
    });
    expect(res.headers.get("location")).toBe(app);
    issue.mockRejectedValueOnce(new Error("boom"));
    res = await get(`/content-view/${PROJECT}/dir/a%20b.html`);
    expect(res.headers.get("location")).toBe(app);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("issues a link only for a page of its own", async () => {
    const res = await get(`/content-view/${PROJECT}/dir/a.html`, {
      "Sec-Fetch-Dest": "iframe",
    });
    expect(res.status).toBe(302);
    expect(issue).not.toHaveBeenCalled();
  });

  it("rejects bad project ids and paths", async () => {
    expect((await get(`/content-view/nope/a.html`)).status).toBe(404);
    // Express itself refuses a malformed escape (400).
    expect(
      (await get(`/content-view/${PROJECT}/%E0%A4%A.html`)).status,
    ).toBeGreaterThanOrEqual(400);
    expect(issue).not.toHaveBeenCalled();
  });
});

describe("the frame URL", () => {
  it("carries the page's query, never the file route's own parameters", () => {
    expect(
      contentFrameUrl(
        LINK,
        "x=1&download&downloadFilename=a.html&viewer=1&share=s&deleteAfterDownload=1&cocalc_project_host_token=t&y=%3C",
      ),
    ).toBe(`${LINK}?x=1&y=%3C`);
  });
  it("never overrides a parameter the link has", () => {
    expect(contentFrameUrl(`${LINK}?v=link`, "v=page&w=2")).toBe(
      `${LINK}?v=link&w=2`,
    );
  });
});
