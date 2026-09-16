import type { AddressInfo } from "node:net";
import express from "express";
import { downloadPublicQuote } from "@cocalc/server/commercial-orders/public-quote";
import initCommercialQuotes from "./commercial-quotes";

jest.mock("@cocalc/server/commercial-orders/public-quote", () => ({
  downloadPublicQuote: jest.fn(),
}));

describe("public quote downloads", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let url: string;
  beforeEach(async () => {
    jest.mocked(downloadPublicQuote).mockReset();
    const app = express();
    const router = express.Router();
    initCommercialQuotes(router);
    app.use("/base", router);
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/base/commercial/quotes/download`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });
  it("serves the clean fragment landing URL without querying billing or third-party assets", async () => {
    const res = await fetch(url + "#" + "a".repeat(64));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const html = await res.text();
    expect(html).toContain("Download quote PDF");
    expect(html).toContain("history.replaceState");
    expect(html).not.toContain("a".repeat(64));
    expect(downloadPublicQuote).not.toHaveBeenCalled();
  });
  it("downloads only the returned PDF with attachment and no-cache headers", async () => {
    jest
      .mocked(downloadPublicQuote)
      .mockResolvedValue({
        filename: "quote.pdf",
        content_base64: Buffer.from("%PDF-test").toString("base64"),
      });
    const res = await fetch(url, {
      method: "POST",
      body: new URLSearchParams({ token: "a".repeat(64) }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.text()).toBe("%PDF-test");
  });
  it("does not disclose internal errors", async () => {
    jest
      .mocked(downloadPublicQuote)
      .mockRejectedValue(Error("private billing details"));
    const res = await fetch(url, {
      method: "POST",
      body: new URLSearchParams({ token: "invalid" }),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("private billing details");
  });
  it("rate-limits repeated requests before resolving tokens", async () => {
    for (let i = 0; i < 30; i++) await fetch(url);
    const res = await fetch(url, {
      method: "POST",
      body: new URLSearchParams({ token: "a".repeat(64) }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(downloadPublicQuote).not.toHaveBeenCalled();
  });
});
