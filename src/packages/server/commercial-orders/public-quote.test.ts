import { createHash } from "node:crypto";
import { downloadPublicQuote } from "./public-quote";

const query = jest.fn();
const remote = jest.fn();
let bay = "seed";
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args) => query(...args) }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => bay,
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => "seed",
}));
jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => ({
    bayOps: (seed) => {
      expect(seed).toBe("seed");
      return { downloadCommercialQuoteInternal: remote };
    },
  }),
}));
jest.mock("./feature-flags", () => ({
  assertCommercialReceivablesCapability: jest.fn(),
}));
const token = "a".repeat(64);
beforeEach(() => {
  query.mockReset();
  remote.mockReset();
  bay = "seed";
});

it("returns only the integrity-checked bounded PDF and atomically limits downloads", async () => {
  const data = Buffer.from("%PDF-test");
  query.mockResolvedValue({
    rows: [
      {
        document_data: data,
        document_sha256: createHash("sha256").update(data).digest("hex"),
        document_filename: "quote.pdf",
      },
    ],
  });
  expect(await downloadPublicQuote(token)).toEqual({
    filename: "quote.pdf",
    content_base64: data.toString("base64"),
  });
  const [sql, values] = query.mock.calls[0];
  expect(sql).toContain("download_window_count<20");
  expect(sql).toContain("download_expires_at>NOW()");
  expect(sql).toContain("valid_until>NOW()");
  expect(sql).toContain("status IN ('issued','accepted')");
  expect(sql).toContain("octet_length(document_data)<=2097152");
  expect(values).toEqual([createHash("sha256").update(token).digest("hex")]);
});
it("does not query for malformed tokens", async () => {
  await expect(downloadPublicQuote("invalid")).rejects.toMatchObject({
    code: 404,
  });
  expect(query).not.toHaveBeenCalled();
});
it("rejects missing, expired, revoked or throttled links without disclosing which", async () => {
  query.mockResolvedValue({ rows: [] });
  await expect(downloadPublicQuote(token)).rejects.toMatchObject({ code: 404 });
});
it("rejects corrupt documents", async () => {
  query.mockResolvedValue({
    rows: [{ document_data: Buffer.from("bad"), document_sha256: "wrong" }],
  });
  await expect(downloadPublicQuote(token)).rejects.toMatchObject({ code: 404 });
});
it("routes attached-bay requests to the seed rather than querying the local DB", async () => {
  bay = "attached";
  remote.mockResolvedValue({ filename: "q.pdf", content_base64: "test" });
  await downloadPublicQuote(token);
  expect(remote).toHaveBeenCalledWith({ token });
  expect(query).not.toHaveBeenCalled();
});
