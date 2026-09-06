/** @jest-environment node */
import { createHash, webcrypto } from "node:crypto";
import { downloadCoverageReport } from "./coverage-download";

beforeAll(() =>
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  }),
);
const backup = "a".repeat(64);
const bytes = Buffer.from('{"type":"header"}\n{"type":"complete"}\n');
const sha256 = createHash("sha256").update(bytes).digest("hex");
const chunk = () => ({
  backup_id: backup,
  bytes: bytes.length,
  sha256,
  data_base64: bytes.toString("base64"),
  next_offset: null,
});
it("downloads exact verified bytes", async () => {
  const blob = await downloadCoverageReport(
    backup,
    async () => chunk(),
    new AbortController().signal,
  );
  expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
});
it("supports bounded continuation chunks", async () => {
  const load = jest.fn(async (offset: number) => ({
    ...chunk(),
    data_base64: bytes
      .subarray(offset, offset ? undefined : 10)
      .toString("base64"),
    next_offset: offset ? null : 10,
  }));
  const blob = await downloadCoverageReport(
    backup,
    load,
    new AbortController().signal,
  );
  expect(await blob.text()).toBe(bytes.toString());
  expect(load.mock.calls).toEqual([[0], [10]]);
});
it.each([
  { bytes: 64 * 1024 * 1024 + 1 },
  { sha256: "b".repeat(64) },
  { backup_id: "b".repeat(64) },
  { next_offset: 0 },
  { data_base64: "" },
  { bytes: bytes.length + 1 },
])(
  "rejects invalid, oversized, truncated or corrupted report %j",
  async (change) => {
    await expect(
      downloadCoverageReport(
        backup,
        async () => ({ ...chunk(), ...change }),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  },
);
it("does not publish after cancellation", async () => {
  const controller = new AbortController();
  await expect(
    downloadCoverageReport(
      backup,
      async () => {
        controller.abort();
        return chunk();
      },
      controller.signal,
    ),
  ).rejects.toThrow();
});
